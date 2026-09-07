export const PRE_ROLL_LANGUAGES = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁体中文'], ['en-US', '英语（美国）'], ['en-GB', '英语（英国）'],
  ['es-ES', '西班牙语'], ['es-MX', '西班牙语（墨西哥）'], ['pt-BR', '葡萄牙语（巴西）'],
  ['fr-FR', '法语'], ['de-DE', '德语'], ['it-IT', '意大利语'], ['ja-JP', '日语'], ['ko-KR', '韩语'],
  ['th-TH', '泰语'], ['vi-VN', '越南语'], ['id-ID', '印尼语'], ['ar-SA', '阿拉伯语'], ['hi-IN', '印地语'], ['ru-RU', '俄语'],
] as const;

export function normalizePreRollLocale(value: string): string {
  const exact = PRE_ROLL_LANGUAGES.find(([code, label]) => code.toLowerCase() === value.toLowerCase() || label === value);
  if (exact) return exact[0];
  const aliases: Record<string, string> = { 中文: 'zh-CN', 英语: 'en-US', 英文: 'en-US', English: 'en-US', 西语: 'es-ES', 葡语: 'pt-BR', 葡萄牙语: 'pt-BR' };
  if (aliases[value]) return aliases[value];
  const base = PRE_ROLL_LANGUAGES.find(([code]) => code.split('-')[0] === value.toLowerCase());
  if (base) return base[0];
  throw new Error('请选择支持的语言');
}

/** Only confident script mismatches are blocked locally. The reviewer handles same-script languages. */
export function dialogueLanguageIssue(value: string, locale: string): string | undefined {
  if (!locale || (value.match(/\p{L}/gu)?.length || 0) < 3) return;
  const code = normalizePreRollLocale(locale).split('-')[0];
  const letters = value.match(/\p{L}/gu) || [];
  const expected: Record<string, RegExp> = { zh: /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, ko: /\p{Script=Hangul}/u, th: /\p{Script=Thai}/u, ar: /\p{Script=Arabic}/u, hi: /\p{Script=Devanagari}/u, ru: /\p{Script=Cyrillic}/u };
  const pattern = expected[code] || /\p{Script=Latin}/u;
  const wrong = letters.filter(c => !pattern.test(c)).length;
  if (wrong >= 3 && wrong / letters.length > 0.5) return `所选${locale}对白语言不符，请只修复对白或字幕字段`;
}
