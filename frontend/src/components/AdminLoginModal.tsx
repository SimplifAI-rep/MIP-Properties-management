import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { getUserErrorMessage } from '../utils/errors';

type AdminLoginModalProps = {
  open: boolean;
  onClose: () => void;
};

export function AdminLoginModal({ open, onClose }: AdminLoginModalProps) {
  const { isAdmin, login, logout } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
      setPending(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(password);
      onClose();
    } catch (err) {
      setError(getUserErrorMessage(err, 'Incorrect password. Please try again.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Admin login"
        className="panel-padded w-full max-w-sm space-y-4 shadow-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="section-title">{isAdmin ? 'Admin session' : 'Admin login'}</h2>
            <p className="mt-1 text-sm text-muted">
              {isAdmin
                ? 'You can reset the database from Data import.'
                : 'Staff only. Clients do not need to sign in.'}
            </p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logout();
                onClose();
              }}
            >
              Log out
            </button>
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={handleSubmit}>
            <label className="block text-sm">
              <span className="label-text">Password</span>
              <input
                type="password"
                className="field"
                value={password}
                autoFocus
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? <p className="text-sm text-negative">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn-primary" disabled={pending || !password}>
                {pending ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
