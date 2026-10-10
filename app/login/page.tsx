import { Suspense } from "react";
import "../ui.css";

export const metadata = { title: "Aangan · Sign in" };

// The only way in is Google. There is no sign-up and no password: an account
// works only if the studio has added that email.
export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="aangan shell login">
      <div className="card login-card">
        <span className="brand-mark" style={{ width: 44, height: 44, fontSize: 20, margin: "0 auto", borderRadius: 12 }}>A</span>
        <h1>Aangan Studio</h1>
        <p>Your leads, callbacks and visits.</p>
        <a className="google-btn" href="/api/auth/google">
          <GoogleLogo /> Sign in with Google
        </a>
        <Suspense fallback={null}>
          <LoginError searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

const ERRORS: Record<string, string> = {
  not_allowed: "This Google account isn't on the studio's list. Ask Pulkit to add you.",
  expired: "That sign-in took too long. Please try again.",
  cancelled: "Sign-in was cancelled.",
  failed: "Sign-in failed. Please try again.",
};

async function LoginError({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { error } = await searchParams;
  const msg = typeof error === "string" ? ERRORS[error] : undefined;
  return msg ? <p className="login-error" role="alert">{msg}</p> : null;
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.87.92 7.53 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
