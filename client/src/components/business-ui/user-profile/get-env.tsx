export function getEnv(): 'BOE' | 'PRE' | 'ONLINE' {
  const { origin } = window.location;
  // 线上环境
  if (
    origin.includes('feishuapp.cn') ||
    origin.includes('miaoda.feishuapp.net')
  ) {
    return 'ONLINE';
    // PRE 环境
  } else if (
    origin.includes('fsapp.kundou.cn') ||
    origin.includes('miaoda-pre.feishuapp.net')
  ) {
    return 'PRE';
    // BOE 环境
  } else {
    return 'BOE';
  }
}
