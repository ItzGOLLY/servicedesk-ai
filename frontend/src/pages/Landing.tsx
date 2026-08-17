import { Link } from 'react-router-dom';

const FEATURES = [
  {
    title: 'Every complaint becomes a ticket',
    body: 'One place to receive requests, with a reference number, an owner, a priority and a status the customer can follow.',
  },
  {
    title: 'AI-assisted triage',
    body: 'New tickets are classified by category, priority and sentiment, and summarised — so nothing sits in a queue unread.',
  },
  {
    title: 'Drafts your agents control',
    body: 'The assistant proposes a reply. Your agent reviews it, edits it and sends it. Nothing reaches a customer automatically.',
  },
  {
    title: 'Reporting that reflects reality',
    body: 'Volume, categories, sentiment, agent workload and resolution time — computed from your live data, not estimates.',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            SD
          </div>
          <span className="text-lg font-bold text-ink">ServiceDesk AI</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link to="/login" className="btn-ghost">
            Sign in
          </Link>
          <Link to="/register" className="btn-primary">
            Get started
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-16 pt-10 sm:pt-16">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <span className="badge bg-brand-50 text-brand-700">Customer Support SaaS</span>
            <h1 className="mt-5 text-4xl font-bold leading-tight text-ink sm:text-5xl">
              Customer support your small business can actually run
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-600">
              Complaints arrive by email, chat and phone, and disappear. ServiceDesk AI turns every
              one into a tracked ticket with an owner and a status — and gives your agents AI
              assistance so a small team can respond like a large one.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register" className="btn-primary px-6 py-3">
                Create an account
              </Link>
              <Link to="/login" className="btn-secondary px-6 py-3">
                Sign in
              </Link>
            </div>
          </div>

          {/* A representative ticket, so the landing page shows the product. */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-card">
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-brand-600">SD-1024</span>
                <div className="flex gap-2">
                  <span className="badge bg-rose-100 text-rose-800">HIGH</span>
                  <span className="badge bg-blue-100 text-blue-800">IN PROGRESS</span>
                </div>
              </div>
              <h3 className="mt-3 font-semibold text-ink">Payment deducted but order still pending</h3>
              <p className="mt-2 text-sm text-slate-600">
                My payment was deducted but my order is still showing as pending. Order #4471.
              </p>

              <div className="mt-5 rounded-lg border border-sea/30 bg-brand-50 p-4">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-sea" />
                  <span className="text-xs font-bold uppercase tracking-wide text-brand-700">
                    AI assistance
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Category</dt>
                    <dd className="font-semibold text-ink">Billing</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Priority</dt>
                    <dd className="font-semibold text-ink">High</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Sentiment</dt>
                    <dd className="font-semibold text-ink">Negative</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-slate-600">
                  <span className="font-semibold">Summary:</span> Payment completed but order status
                  remains pending.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-slate-50 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-2xl font-bold text-ink">What you get</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="card p-6">
                <h3 className="font-semibold text-ink">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8">
        <div className="mx-auto max-w-6xl px-6 text-sm text-slate-500">
          <p className="font-medium text-slate-600">ServiceDesk AI</p>
          <p className="mt-1">
            BCSE408L Cloud Computing · School of Computer Science Engineering and Information
            Systems · VIT Chennai
          </p>
        </div>
      </footer>
    </div>
  );
}
