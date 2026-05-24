"""用卡开通 Grok Pro trial 订阅
用法: python card_subscribe.py --sso <token> --card <卡号> --exp <MM/YY> --cvc <CVC>
"""
import sys, os, json, time, uuid, re, argparse
sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)
import requests
from curl_cffi import requests as cf

PK = 'pk_live_51PksddHJohyvID2czYoS55WPrVoy5tQ2a6QqoEFqeZV85CCGShKYpZ6rn5wzdY1HhNzcttFdZuTsCrwip8Qp3PSN00boS3LmEd'
# 🆕 从环境变量读取 YesCaptcha clientKey（由 Node 包装器 grok-subscribe.js 注入）
# 这样前端 tab 填的 key、服务器 .env 配的 key 都能传进来
YESCAPTCHA_KEY = os.environ.get('YESCAPTCHA_KEY', '')


def solve_hcaptcha(site_key, page_url, rqdata, max_retries=3):
    """解 hCaptcha (enterprise + rqdata 绑定) - 最多重试 max_retries 次

    重试逻辑：
    - 内层保留原 3 级 fallback (enterprise → non-enterprise → no-rqdata)
    - 外层对"task failed / timeout"重试 max_retries 次（每次重新 createTask）
    - 每次失败打印 YesCaptcha errorCode/errorDescription 便于排查
    """
    if not YESCAPTCHA_KEY:
        print('    [WARN] YESCAPTCHA_KEY 未配置，无法解 hCaptcha')
        return None

    last_err = ''
    for attempt in range(1, max_retries + 1):
        if attempt > 1:
            print(f'    [retry {attempt}/{max_retries}] 上次失败: {last_err}')
            time.sleep(2)

        task = {
            'type': 'HCaptchaTaskProxyless',
            'websiteURL': page_url,
            'websiteKey': site_key,
            'isEnterprise': True,
            'enterprisePayload': {'rqdata': rqdata},
        }
        cr = requests.post('https://api.yescaptcha.com/createTask',
            json={'clientKey': YESCAPTCHA_KEY, 'task': task}, timeout=30).json()
        if cr.get('errorId'):
            print(f'    Enterprise failed: {cr.get("errorDescription")}')
            # fallback: 保留 rqdata 但去掉 isEnterprise
            task['isEnterprise'] = False
            cr = requests.post('https://api.yescaptcha.com/createTask',
                json={'clientKey': YESCAPTCHA_KEY, 'task': task}, timeout=30).json()
            if cr.get('errorId'):
                print(f'    Non-enterprise also failed: {cr.get("errorDescription")}')
                # last fallback: no enterprise payload at all
                del task['enterprisePayload']
                task['isEnterprise'] = False
                cr = requests.post('https://api.yescaptcha.com/createTask',
                    json={'clientKey': YESCAPTCHA_KEY, 'task': task}, timeout=30).json()
                if cr.get('errorId'):
                    last_err = f'createTask: code={cr.get("errorCode","")} desc={cr.get("errorDescription","")}'
                    print(f'    createTask 全部失败: {last_err}')
                    continue  # 进入下一次重试
                print('    WARNING: solving without rqdata!')
            else:
                print('    Using non-enterprise with rqdata')
        else:
            print(f'    [attempt {attempt}] Enterprise mode OK')

        tid = cr['taskId']
        polling_timed_out = True
        for i in range(60):
            time.sleep(3)
            tr = requests.post('https://api.yescaptcha.com/getTaskResult',
                json={'clientKey': YESCAPTCHA_KEY, 'taskId': tid}, timeout=15).json()
            if tr.get('status') == 'ready':
                return tr.get('solution', {}).get('gRecaptchaResponse')
            if tr.get('status') == 'failed':
                last_err = f'taskFailed: code={tr.get("errorCode","")} desc={tr.get("errorDescription","")}'
                print(f'    YesCaptcha 返回失败: {last_err}')
                polling_timed_out = False
                break  # 跳出轮询，进入下一次重试
            if i % 5 == 0 and i > 0:
                print(f'    waiting ({i*3}s, attempt {attempt})...')
        if polling_timed_out:
            last_err = 'timeout 180s 未出结果'
            print(f'    YesCaptcha 轮询 {last_err}')

    print(f'    captcha {max_retries} 次重试全部失败: {last_err}')
    return None


def subscribe(sso, card_number, exp_month, exp_year, cvc, proxy=None):
    proxies = {'https': proxy, 'http': proxy} if proxy else {}
    cookies = {'sso': sso, 'sso-rw': sso}
    gh = {'accept': '*/*', 'content-type': 'application/json', 'origin': 'https://grok.com', 'referer': 'https://grok.com/'}
    s = requests.Session()
    if proxies:
        s.proxies.update(proxies)

    # 1. Checkout session
    print('[1] Checkout session...')
    r = cf.post('https://grok.com/rest/subscriptions/subscribe/new', headers=gh, cookies=cookies,
        json={'stripeHosted':{'successUrl':'https://grok.com/?checkout=success'},'priceId':'price_1R6nQ9HJohyvID2ck7FNrVdw','ignoreExistingActiveSubscriptions':True,'subscriptionType':'MONTHLY','requestedTier':'REQUESTED_TIER_GROK_PRO','campaignId':'subcamp_HeAxW'},
        impersonate='chrome131', timeout=15, proxies=proxies, allow_redirects=False, default_headers=False)
    if r.status_code != 200:
        # 🆕 把响应体打出来（截断 600 字符）+ content-type，便于诊断
        body_text = ''
        try:
            body_text = r.text[:600]
        except Exception:
            body_text = '<unable to read body>'
        ctype = ''
        try:
            ctype = r.headers.get('content-type', '')
        except Exception:
            pass
        print(f'    Grok resp content-type: {ctype}')
        print(f'    Grok resp body[:600]: {body_text}')
        # 同时尝试解析 JSON 拿到 error code（如果是结构化错误）
        err_summary = ''
        try:
            j = r.json()
            err_summary = f"code={j.get('code') or j.get('error',{}).get('code','')}  msg={j.get('message') or j.get('error',{}).get('message','')[:120]}"
        except Exception:
            err_summary = body_text[:160]
        return {'error': f'checkout HTTP {r.status_code} | {err_summary}', 'body': body_text}
    # 解析 url，加 try 防止非 JSON 响应
    try:
        url_str = r.json().get('url', '')
    except Exception:
        print(f'    Grok 200 但响应非 JSON: {r.text[:300]}')
        return {'error': f'checkout 200 but non-JSON response: {r.text[:200]}'}
    m = re.search(r'cs_live_[a-zA-Z0-9]+', url_str)
    if not m:
        return {'error': f'no session id in url: {url_str[:200]}'}
    sid = m.group(0)

    # 2. Init + USD
    print('[2] Init + USD...')
    init_resp = s.post(f'https://api.stripe.com/v1/payment_pages/{sid}/init',
        data={'key':PK,'eid':'NA','browser_locale':'en-US','redirect_type':'url'}, timeout=15)
    if init_resp.status_code != 200:
        print(f'    Stripe init body[:400]: {init_resp.text[:400]}')
        return {'error': f'stripe init HTTP {init_resp.status_code}'}
    init = init_resp.json()
    eid = init.get('eid','NA')
    cs = init.get('init_checksum','')
    upd = s.post(f'https://api.stripe.com/v1/payment_pages/{sid}',
        data={'eid':eid,'updated_currency':'usd','key':PK}, timeout=15)
    if upd.status_code == 200:
        cs = upd.json().get('init_checksum', cs)

    # 3. Create card PM
    print('[3] Create PM...')
    guid = uuid.uuid4().hex[:24]+'987feb'
    muid = uuid.uuid4().hex[:24]+'fe8700'
    sid_fp = uuid.uuid4().hex[:24]+'efa5fc'
    pm_r = s.post('https://api.stripe.com/v1/payment_methods', data={
        'type':'card','card[number]':card_number,
        'card[exp_month]':exp_month,'card[exp_year]':exp_year,'card[cvc]':cvc,
        'billing_details[name]':'John Smith',
        'billing_details[address][country]':'US','billing_details[address][postal_code]':'10001',
        'key':PK,'guid':guid,'muid':muid,'sid':sid_fp,
    }, timeout=15)
    if pm_r.status_code != 200:
        err = pm_r.json().get('error',{})
        return {'error': f'PM: {err.get("code")} {err.get("decline_code")} {err.get("message","")[:80]}'}
    pm_id = pm_r.json()['id']

    # 4. Confirm
    print('[4] Confirm...')
    cd = s.post(f'https://api.stripe.com/v1/payment_pages/{sid}/confirm', data={
        'eid':eid,'payment_method':pm_id,'expected_amount':'0','expected_payment_method_type':'card',
        'return_url':f'https://checkout.stripe.com/c/pay/{sid}','key':PK,'init_checksum':cs,
        'guid':guid,'muid':muid,'sid':sid_fp,
    }, timeout=30).json()

    if cd.get('error'):
        err = cd['error']
        return {'error': f'confirm: {err.get("code")} {err.get("decline_code")} {err.get("message","")[:100]}'}

    si = cd.get('setup_intent') or {}
    status = si.get('status','')

    if status == 'succeeded':
        return {'success': True}

    if status == 'requires_action':
        sdk = si.get('next_action',{}).get('use_stripe_sdk',{})
        sdk_type = sdk.get('type','')

        if sdk_type == 'intent_confirmation_challenge':
            stripe_js = sdk.get('stripe_js',{})
            site_key = stripe_js.get('site_key','')
            rqdata = stripe_js.get('rqdata','')
            verify_url = stripe_js.get('verification_url','')
            seti_secret = si['client_secret']

            # 5. Solve hCaptcha
            print('[5] Solving hCaptcha...')
            token = solve_hcaptcha(site_key, f'https://js.stripe.com/v3/', rqdata)
            if not token:
                return {'error': 'captcha solve failed'}
            print(f'    Token: {token[:40]}...')

            # 6. Verify challenge
            print('[6] Verify challenge...')
            vr = s.post(f'https://api.stripe.com{verify_url}', data={
                'client_secret': seti_secret,
                'key': PK,
                'captcha_vendor_name': 'hcaptcha',
            }, timeout=30)
            vd = vr.json()
            if vd.get('status') == 'succeeded':
                return {'success': True}
            err = vd.get('last_setup_error') or vd.get('error') or {}
            return {'error': f'verify: {err.get("message","")[:150]}', 'status': vd.get('status')}

        elif sdk_type == 'three_d_secure_redirect':
            return {'error': '3DS required'}
        else:
            return {'error': f'unknown action: {sdk_type}'}

    return {'error': f'unexpected: {status}'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sso', required=True)
    parser.add_argument('--card', required=True)
    parser.add_argument('--exp', required=True, help='MM/YY')
    parser.add_argument('--cvc', required=True)
    parser.add_argument('--proxy', default='http://127.0.0.1:10808')
    args = parser.parse_args()

    exp_parts = args.exp.split('/')
    exp_month = exp_parts[0]
    exp_year = '20' + exp_parts[1] if len(exp_parts[1]) == 2 else exp_parts[1]

    print(f'Card: ...{args.card[-4:]} Exp: {exp_month}/{exp_year}')
    result = subscribe(args.sso, args.card, exp_month, exp_year, args.cvc, args.proxy)
    print(json.dumps(result, indent=2, ensure_ascii=False))
