/** Download a UTF-8 CSV (BOM so Excel on Windows keeps Hebrew). */
export function downloadCsv(
  rows: Record<string, string | number | null>[],
  filename: string,
): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          const text = value == null ? '' : String(value);
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(','),
    ),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function sanitizeCsvFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'report';
}

/** CSV download name from owner names — one owner becomes `David Cohen.csv`. */
export function ownerCsvFilename(ownerNames: string[]): string {
  const unique = [
    ...new Set(ownerNames.map((name) => name.trim()).filter(Boolean)),
  ];
  if (unique.length === 1) return `${sanitizeCsvFilename(unique[0])}.csv`;
  if (unique.length === 2 || unique.length === 3) {
    return `${unique.map(sanitizeCsvFilename).join(' + ')}.csv`;
  }
  if (unique.length > 3) return 'owners.csv';
  return 'report.csv';
}
