export function stocktakeWarehouse(location: string): string {
  const value = location.trim().replace(/\s+/g, ' ');
  if (!value) return '未配置库房';
  const separated = value.split(/\s*[·|｜]\s*/)[0];
  if (separated !== value) return separated;
  const named = value.match(
    /^(.+?(?:储藏间|储存间|储藏室|值班室|强电间|弱电间|空调间|冷冻站|配电间|仓库|总库|库房))[-\s]*\d+(?:F|层)?[-\s]\d+(?:F|层)?$/i,
  );
  if (named) return named[1];
  return value.match(/^([A-Z]-\d+)-\d+-\d+$/i)?.[1] || value;
}
