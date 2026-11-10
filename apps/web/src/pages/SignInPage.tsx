import {
  createUserWithEmailAndPassword,
  RecaptchaVerifier,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from 'firebase/auth';
import { normalizeGhanaPhone } from '@courier/validation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Field } from '../components/Field';
import { useAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';

type Mode = 'phone' | 'email-signin' | 'email-signup';

const authMessage = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email or password is incorrect.';
  if (code.includes('email-already-in-use')) return 'An account already exists with this email. Sign in instead.';
  if (code.includes('weak-password')) return 'Use a password with at least 8 characters.';
  if (code.includes('invalid-verification-code')) return 'That code is not correct.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait and try again.';
  return (e as { message?: string }).message ?? 'Something went wrong.';
};

export function SignInPage() {
  const { user, role, loading, finishSignUp } = useAuth();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/account';
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('phone');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const recaptcha = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => () => recaptcha.current?.clear(), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(authMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await finishSignUp(name.trim() || undefined);
    navigate(next, { replace: true });
  };

  if (!loading && user && role) return <Navigate to={next} replace />;

  const awaitingVerification = Boolean(user && !role && user.email && !user.emailVerified && !user.phoneNumber);

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      const { auth } = getFirebase();
      if (mode === 'email-signup') {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(cred.user);
        setNotice(`We sent a verification link to ${email.trim()}. Open it, then press “I have verified my email”.`);
      } else {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        if (cred.user.emailVerified) await finish();
      }
    });
  }

  function submitPhone(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      const { auth } = getFirebase();
      if (!confirmation) {
        const e164 = normalizeGhanaPhone(phone);
        if (!e164) throw new Error('Enter a valid Ghana mobile number.');
        recaptcha.current ??= new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
        setConfirmation(await signInWithPhoneNumber(auth, e164, recaptcha.current));
        setNotice(`We sent a 6-digit code to ${e164}.`);
      } else {
        await confirmation.confirm(code.trim());
        await finish();
      }
    });
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="mb-2 text-3xl font-bold">Your account</h1>
      <p className="mb-6 text-slate-600">Sign in to see your bookings, save addresses and pay faster. Booking without an account still works.</p>

      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="mb-4 rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">{notice}</p>}

      {awaitingVerification ? (
        <div className="card space-y-4">
          <p className="text-sm">Please verify {user!.email} using the link we emailed you.</p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await user!.reload();
                  if (!user!.emailVerified) throw new Error('Your email is not verified yet.');
                  await user!.getIdToken(true);
                  await finish();
                })
              }
            >
              I have verified my email
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => run(() => sendEmailVerification(user!))}>
              Resend email
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(
              [
                ['phone', 'Phone'],
                ['email-signin', 'Email sign in'],
                ['email-signup', 'Create account'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`rounded-md py-2 ${mode === m ? 'bg-white shadow-sm' : 'text-slate-600'}`}
                onClick={() => {
                  setMode(m);
                  setError(null);
                  setNotice(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'phone' ? (
            <form onSubmit={submitPhone} className="card space-y-4" noValidate>
              <Field label="Your name" optional>
                {(p) => <input {...p} className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
              </Field>
              <Field label="Mobile number">
                {(p) => (
                  <input {...p} className="input" type="tel" placeholder="024 123 4567" disabled={!!confirmation} value={phone} onChange={(e) => setPhone(e.target.value)} />
                )}
              </Field>
              {confirmation && (
                <Field label="6-digit code">
                  {(p) => <input {...p} className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
                </Field>
              )}
              <button className="btn-primary w-full" disabled={busy}>
                {confirmation ? 'Verify code' : 'Send code'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitEmail} className="card space-y-4" noValidate>
              {mode === 'email-signup' && (
                <Field label="Your name" optional>
                  {(p) => <input {...p} className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
                </Field>
              )}
              <Field label="Email">
                {(p) => <input {...p} className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
              <Field label="Password" hint={mode === 'email-signup' ? 'At least 8 characters' : undefined}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    type="password"
                    autoComplete={mode === 'email-signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <button className="btn-primary w-full" disabled={busy || (mode === 'email-signup' && password.length < 8)}>
                {mode === 'email-signup' ? 'Create account' : 'Sign in'}
              </button>
              {mode === 'email-signin' && (
                <button
                  type="button"
                  className="text-sm text-brand-700 hover:underline"
                  onClick={() =>
                    run(async () => {
                      if (!email.trim()) throw new Error('Enter your email first.');
                      await sendPasswordResetEmail(getFirebase().auth, email.trim());
                      setNotice('If an account exists for that email, a reset link is on its way.');
                    })
                  }
                >
                  Forgot password?
                </button>
              )}
            </form>
          )}
        </>
      )}
      <div id="recaptcha-container" />
    </div>
  );
}
