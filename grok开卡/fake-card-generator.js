/**
 * 本地假 Visa 卡号生成器
 *
 * 用 Luhn 算法生成符合校验的 16 位 Visa 卡号：
 *   - 前缀：4147 或 4100 随机
 *   - 过期年份：当前年份 + 2~5 年随机
 *   - CVV：100~999 随机
 *
 * ⚠️ 警告：这是用于测试/模拟场景的"假卡"，Stripe Live 真实风控会直接拒绝
 * （常见返回 card_declined / incorrect_number / generic_decline）。
 * 仅供调试 / 流程验证 / 异常分支测试使用，请勿用于生产支付。
 *
 * 移植自 GuJumpgate/content/paypal-flow.js#buildHostedVisaCard
 */

'use strict';

/**
 * 生成一张本地假 Visa 卡
 * @returns {{ number: string, expMonth: string, expYear: string, cvv: string, expiry: string }}
 *   - number    : 16 位卡号（无空格）
 *   - expMonth  : "MM"（两位月份）
 *   - expYear   : "YYYY"（四位年份）
 *   - cvv       : "XXX"（三位 CVV）
 *   - expiry    : "MM/YY"（Stripe 表单常见格式）
 */
function generateFakeVisaCard() {
    const prefixes = [
        [4, 1, 4, 7],
        [4, 1, 0, 0],
    ];
    const digits = prefixes[Math.floor(Math.random() * prefixes.length)].slice();
    while (digits.length < 15) {
        digits.push(Math.floor(Math.random() * 10));
    }

    // Luhn 校验位：从右向左，奇数位 *2（超过 9 减 9），求和 mod 10
    const reversed = digits.slice().reverse();
    let sum = 0;
    for (let index = 0; index < reversed.length; index += 1) {
        let digit = reversed[index];
        if (index % 2 === 0) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }
        sum += digit;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    digits.push(checkDigit);

    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const currentYearShort = new Date().getFullYear() % 100;
    const yearShortNum = currentYearShort + Math.floor(Math.random() * 4) + 2;
    const yearShort = String(yearShortNum).padStart(2, '0');
    const expYear = `20${yearShort}`;
    const cvv = String(Math.floor(100 + Math.random() * 900));

    return {
        number: digits.join(''),
        expMonth: month,
        expYear,
        cvv,
        expiry: `${month}/${yearShort}`,
    };
}

module.exports = { generateFakeVisaCard };
