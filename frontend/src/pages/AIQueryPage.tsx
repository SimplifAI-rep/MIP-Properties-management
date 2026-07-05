export function AIQueryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">AI Query</h2>
        <p className="mt-1 text-sm text-slate-500">
          Natural-language questions about deposit data will be available in the next phase.
        </p>
      </div>

      <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8">
        <h3 className="font-semibold text-slate-900">Coming soon — Phase 4</h3>
        <p className="mt-2 text-sm text-slate-600">
          You will be able to ask questions like:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-600">
          <li>Show all deposits for Rothschild 12 in Q1 2026</li>
          <li>Which properties had no deposit in March 2026?</li>
          <li>Total deposits per owner this year</li>
        </ul>
      </section>
    </div>
  );
}
