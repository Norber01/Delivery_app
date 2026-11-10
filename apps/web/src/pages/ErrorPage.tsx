import { useRouteError } from 'react-router';
import { config } from '../lib/config';

export function ErrorPage() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="mb-2 text-3xl font-bold">Something went wrong</h1>
      <p className="mb-6 text-slate-600">
        Please reload the page and try again.{config.supportPhone && ` If the problem continues, call us on ${config.supportPhone}.`}
      </p>
      <a href="/" className="btn-primary">
        Reload
      </a>
    </div>
  );
}
