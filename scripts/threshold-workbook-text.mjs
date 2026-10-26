// WPS shared strings can contain an empty direct <t> followed by rich-text runs.
// SheetJS keeps those runs in cell.r but may return only the empty direct text.
export function normalizeThresholdWorkbookText(book) {
  const repaired = [];
  const decode = (text) =>
    text
      .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (!entity.startsWith('#')) return named[entity.toLowerCase()];
        const point =
          entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return String.fromCodePoint(point);
      })
      .replace(/_x([\da-f]{4})_/gi, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\r\n?/g, '\n');
  for (const name of book.SheetNames) {
    for (const [address, cell] of Object.entries(book.Sheets[name])) {
      if (address.startsWith('!') || cell.t !== 's' || !cell.r) continue;
      const xml = cell.r.replace(
        /<(?:\w+:)?rPh\b[^>]*>[\s\S]*?<\/(?:\w+:)?rPh\s*>/g,
        '',
      );
      const parts = [
        ...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t\s*>/g),
      ];
      if (!parts.length) continue;
      const value = parts.map((part) => decode(part[1])).join('');
      if (value !== cell.v) {
        cell.v = value;
        delete cell.w;
        delete cell.h;
        repaired.push({ sheet: name, cell: address });
      }
    }
  }
  return repaired;
}
