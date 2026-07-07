import * as XLSX from 'xlsx';
import type { AIQueryResponse } from '../types';

function buildFilename(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '');
  const date = new Date().toISOString().slice(0, 10);
  return `ai-query-${slug || 'results'}-${date}.xlsx`;
}

export function downloadAIQueryExcel(result: AIQueryResponse, question: string): void {
  const workbook = XLSX.utils.book_new();

  const summaryRows = [
    ['Question', question],
    ['Answer', result.answer],
    ['Domain', result.query_used.domain ?? 'deposits'],
    ['Query type', result.query_used.query_type],
    ['Parser', result.parser],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  if (result.data.length > 0) {
    const resultsSheet = XLSX.utils.json_to_sheet(result.data);
    XLSX.utils.book_append_sheet(workbook, resultsSheet, 'Results');
  } else {
    const emptySheet = XLSX.utils.aoa_to_sheet([['No data rows returned']]);
    XLSX.utils.book_append_sheet(workbook, emptySheet, 'Results');
  }

  XLSX.writeFile(workbook, buildFilename(question));
}
