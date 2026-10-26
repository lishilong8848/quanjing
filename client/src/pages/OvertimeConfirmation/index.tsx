import { OvertimeConfirmationDeepLinkHost } from '../MonthlySchedule/OvertimeConfirmationDeepLinkHost';

export default function OvertimeConfirmationPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6">
      <section className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-3xl items-center justify-center">
        <div
          className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-center shadow-sm"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <img
            src="/assets/vnet-official-logo.png"
            alt="世纪互联"
            className="mx-auto h-10 w-auto"
          />
          <p className="mt-3 text-sm font-medium text-slate-600">
            正在打开加班确认…
          </p>
        </div>
      </section>
      <OvertimeConfirmationDeepLinkHost />
    </main>
  );
}
