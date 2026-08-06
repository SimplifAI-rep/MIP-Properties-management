import { formatCurrency, formatDate } from './States';

function renderCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

type DataResultTableProps = {
  data: Record<string, unknown>[];
  emptyMessage?: string;
};

/** Generic aggregate / key-value result table (AI Query, future Reports). */
export function DataResultTable({
  data,
  emptyMessage = 'No rows returned.',
}: DataResultTableProps) {
  if (data.length === 0) {
    return <p className="muted-text">{emptyMessage}</p>;
  }

  const columns = Object.keys(data[0]);

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="table-shell">
        <thead className="table-head">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-4 py-2 font-medium">
                {column.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr key={index} className="table-row">
              {columns.map((column) => (
                <td key={column} className="px-4 py-2">
                  {column.includes('amount') || column.includes('total')
                    ? row[column] != null
                      ? formatCurrency(renderCell(row[column]))
                      : ''
                    : column.includes('date') && row[column]
                      ? formatDate(renderCell(row[column]))
                      : renderCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
