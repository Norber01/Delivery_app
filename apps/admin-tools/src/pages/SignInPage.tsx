import {
  getMultiFactorResolver,
  multiFactor,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
} from 'firebase/auth';
import { normalizeGhanaPhone } from '@courier/validation';
import { useRef, useState, type FormEvent } from 'react';
import { useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';

const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email or password is incorrect.';
  if (code.includes('invalid-verification-code')) return 'That code is not correct.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a few minutes.';
  if (code.includes('requires-recent-login')) return 'Please sign out and sign in again before enrolling.';
  return (e as Error).message ?? 'Something went wrong.';
};

function useRecaptcha() {
  const verifier = useRef<RecaptchaVerifier | null>(null);
  return () => (verifier.current ??= new RecaptchaVerifier(getFirebase().auth, 'recaptcha', { size: 'invisible' }));
}

/** Email + password, then the second factor (SMS code or authenticator app). */
export function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [smsVerificationId, setSmsVerificationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recaptcha = useRecaptcha();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const hint = resolver?.hints[0];

  async function signIn(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const { auth } = getFirebase();
      try {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } catch (err) {
        if ((err as { code?: string }).code !== 'auth/multi-factor-auth-required') throw err;
        const r = getMultiFactorResolver(auth, err as MultiFactorError);
        const h = r.hints[0];
        // Send the SMS before showing the code prompt, so a code can never be submitted early.
        if (h?.factorId === PhoneMultiFactorGenerator.FACTOR_ID) {
          const id = await new PhoneAuthProvider(auth).verifyPhoneNumber({ multiFactorHint: h, session: r.session }, recaptcha());
          setSmsVerificationId(id);
        }
        setResolver(r);
      }
    });
  }

  async function verifySecondFactor(e: FormEvent) {
    e.preventDefault();
    if (!resolver || !hint) return;
    await run(async () => {
      const assertion =
        hint.factorId === TotpMultiFactorGenerator.FACTOR_ID
          ? TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim())
          : PhoneMultiFactorGenerator.assertion(PhoneAuthProvider.credential(smsVerificationId!, code.trim()));
      await resolver.resolveSignIn(assertion);
    });
  }

  return (
    <Centered title="Operations sign in">
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!resolver ? (
        <form onSubmit={signIn} className="space-y-3">
          <Input label="Work email" type="email" value={email} onChange={setEmail} autoComplete="username" />
          <Input label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          <button className="btn-primary w-full" disabled={busy}>
            Continue
          </button>
        </form>
      ) : (
        <form onSubmit={verifySecondFactor} className="space-y-3">
          <p className="text-sm text-slate-600">
            {hint?.factorId === TotpMultiFactorGenerator.FACTOR_ID
              ? 'Enter the 6-digit code from your authenticator app.'
              : `Enter the code we sent to ${(hint as { phoneNumber?: string })?.phoneNumber ?? 'your phone'}.`}
          </p>
          <Input label="Verification code" value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" />
          <button
            className="btn-primary w-full"
            disabled={busy || code.trim().length < 6 || (hint?.factorId === PhoneMultiFactorGenerator.FACTOR_ID && !smsVerificationId)}
          >
            Verify
          </button>
        </form>
      )}
      <div id="recaptcha" />
    </Centered>
  );
}

/** Shown to staff signed in without a second factor: enrol one, then sign in again. */
export function EnrollMfaPage() {
  const { user, signOut } = useStaffAuth();
  const [mode, setMode] = useState<'totp' | 'sms'>('totp');
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [phone, setPhone] = useState('');
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const recaptcha = useRecaptcha();
  const enrolled = user ? multiFactor(user).enrolledFactors : [];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (done || enrolled.length > 0) {
    return (
      <Centered title="Sign in with your second factor">
        <p className="text-sm text-slate-600">
          Two-step verification is set up. Sign out and sign in again, completing the verification step, to use operations tools.
        </p>
        <button className="btn-primary w-full" onClick={() => signOut()}>
          Sign out and sign in again
        </button>
      </Centered>
    );
  }

  return (
    <Centered title="Set up two-step verification">
      <p className="text-sm text-slate-600">Operations staff must use a second factor. Choose an authenticator app (recommended) or SMS.</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {(['totp', 'sms'] as const).map((m) => (
          <button key={m} type="button" className={`rounded-md py-1.5 ${mode === m ? 'bg-white shadow-sm' : ''}`} onClick={() => setMode(m)}>
            {m === 'totp' ? 'Authenticator app' : 'SMS'}
          </button>
        ))}
      </div>
      {mode === 'totp' ? (
        !secret ? (
          <button
            className="btn-primary w-full"
            disabled={busy}
            onClick={() =>
              run(async () => setSecret(await TotpMultiFactorGenerator.generateSecret(await multiFactor(user!).getSession())))
            }
          >
            Generate setup key
          </button>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await multiFactor(user!).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, code.trim()), 'Authenticator');
                setDone(true);
              });
            }}
          >
            <p className="text-sm">Add this key to Google Authenticator, Microsoft Authenticator or similar:</p>
            <p className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-sm">{secret.secretKey}</p>
            <a className="text-sm text-brand-700 underline" href={secret.generateQrCodeUrl(user!.email ?? 'staff', 'Courier Ops')}>
              Open in authenticator app
            </a>
            <Input label="Code from the app" value={code} onChange={setCode} inputMode="numeric" />
            <button className="btn-primary w-full" disabled={busy}>
              Confirm
            </button>
          </form>
        )
      ) : !verificationId ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const e164 = normalizeGhanaPhone(phone);
              if (!e164) throw new Error('Enter a valid Ghana mobile number.');
              const session = await multiFactor(user!).getSession();
              setVerificationId(await new PhoneAuthProvider(getFirebase().auth).verifyPhoneNumber({ phoneNumber: e164, session }, recaptcha()));
            });
          }}
        >
          <Input label="Mobile number" value={phone} onChange={setPhone} type="tel" />
          <button className="btn-primary w-full" disabled={busy}>
            Send code
          </button>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await multiFactor(user!).enroll(PhoneMultiFactorGenerator.assertion(PhoneAuthProvider.credential(verificationId, code.trim())), 'Phone');
              setDone(true);
            });
          }}
        >
          <Input label="Code" value={code} onChange={setCode} inputMode="numeric" />
          <button className="btn-primary w-full" disabled={busy}>
            Confirm
          </button>
        </form>
      )}
      <button className="text-sm text-slate-500 hover:underline" onClick={() => signOut()}>
        Sign out
      </button>
      <div id="recaptcha" />
    </Centered>
  );
}

export function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function Input(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'tel';
}) {
  return (
    <label className="block space-y-1 text-sm font-medium text-slate-700">
      <span>{props.label}</span>
      <input
        className="input"
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
