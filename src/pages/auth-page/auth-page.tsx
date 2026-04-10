import { Button } from '@/components/button/button';
import { Input } from '@/components/input/input';
import { Label } from '@/components/label/label';
import { useAuth } from '@/hooks/use-auth';
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

type AuthMode = 'login' | 'reset';

export const AuthPage: React.FC = () => {
    const [mode, setMode] = useState<AuthMode>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');
    const [loading, setLoading] = useState(false);

    const { signIn, sendPasswordReset } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setInfo('');

        setLoading(true);
        try {
            if (mode === 'login') {
                await signIn(email, password);
                navigate('/', { replace: true });
            } else {
                await sendPasswordReset(email);
                setInfo('Password reset email sent. Check your inbox.');
            }
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : 'An error occurred.';
            setError(friendlyFirebaseMessage(message));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-md">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">
                        ChartDB
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {mode === 'login'
                            ? 'Sign in to your account'
                            : 'Reset your password'}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-1">
                        <Label htmlFor="email">Email</Label>
                        <Input
                            id="email"
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                        />
                    </div>

                    {mode === 'login' && (
                        <div className="space-y-1">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                type="password"
                                autoComplete="current-password"
                                required
                                minLength={6}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                            />
                        </div>
                    )}

                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                    {info && (
                        <p className="text-sm text-green-600 dark:text-green-400">
                            {info}
                        </p>
                    )}

                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading
                            ? 'Please wait…'
                            : mode === 'login'
                              ? 'Sign In'
                              : 'Send Reset Email'}
                    </Button>
                </form>

                {mode === 'login' && (
                    <p className="mt-4 text-center text-sm text-muted-foreground">
                        <button
                            type="button"
                            className="underline-offset-4 hover:underline"
                            onClick={() => {
                                setMode('reset');
                                setError('');
                            }}
                        >
                            Forgot your password?
                        </button>
                    </p>
                )}

                {mode === 'reset' && (
                    <p className="mt-4 text-center text-sm text-muted-foreground">
                        <button
                            type="button"
                            className="underline-offset-4 hover:underline"
                            onClick={() => {
                                setMode('login');
                                setInfo('');
                                setError('');
                            }}
                        >
                            Back to sign in
                        </button>
                    </p>
                )}
            </div>
        </div>
    );
};

/** Convert Firebase error codes into friendlier messages. */
function friendlyFirebaseMessage(message: string): string {
    if (
        message.includes('invalid-credential') ||
        message.includes('wrong-password') ||
        message.includes('user-not-found')
    ) {
        return 'Invalid email or password.';
    }
    if (message.includes('invalid-email')) {
        return 'Please enter a valid email address.';
    }
    if (message.includes('too-many-requests')) {
        return 'Too many attempts. Please try again later.';
    }
    return message;
}
