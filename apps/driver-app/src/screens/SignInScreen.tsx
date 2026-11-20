import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text } from 'react-native';
import { Button, Field, Notice, s } from '../components/ui';
import { config } from '../services/config';
import { auth } from '../services/firebase';

export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  return (
    <KeyboardAvoidingView behavior="padding" style={s.screen}>
      <ScrollView contentContainerStyle={[s.content, { paddingTop: 64 }]}>
        <Text style={s.h1}>{config.companyName} Rider</Text>
        <Text style={s.muted}>Sign in with the work email your supervisor set up for you.</Text>
        {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'ok'}>{msg.text}</Notice>}
        <Field label="Work email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} />
        <Field label="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} />
        <Button
          title="Sign in"
          busy={busy}
          onPress={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
              const role = (await cred.user.getIdTokenResult()).claims.role;
              if (role !== 'driver') {
                await auth.signOut();
                setMsg({ tone: 'error', text: 'This account is not a rider account.' });
              }
            } catch {
              setMsg({ tone: 'error', text: 'Email or password is incorrect, or you are offline.' });
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button
          title="Forgot password"
          tone="secondary"
          onPress={async () => {
            if (!email.trim()) return setMsg({ tone: 'error', text: 'Enter your email first.' });
            await sendPasswordResetEmail(auth, email.trim()).catch(() => undefined);
            setMsg({ tone: 'ok', text: 'If the account exists, a reset link has been emailed.' });
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
