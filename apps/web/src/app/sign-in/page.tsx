import { headers } from 'next/headers';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { signIn, localSignIn } from '@/lib/actions';
import { localDemoAllowed } from '@/lib/action-policy';
import { PageHeading } from '@/components/workspace-ui';
export const metadata = { title: 'Sign in' };
export default async function SignIn() {
  const local = localDemoAllowed(process.env, (await headers()).get('host'));
  return (
    <div className="page-content">
      <PageHeading title="Sign in" description="Access your organization’s support workspace." />
      <section className="content-card sign-in-card">
        <h2>Workspace access key</h2>
        <p>
          Use the expiring key issued by your workspace administrator. Your membership determines
          which records and actions are available.
        </p>
        <ActionForm action={signIn} label="Connect workspace">
          <label>
            Access key
            <input
              type="password"
              name="accessKey"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="rh_…"
              minLength={46}
              maxLength={46}
            />
          </label>
        </ActionForm>
        {local && (
          <div className="local-demo">
            <h3>Local synthetic workspace</h3>
            <p>
              This development-only workspace uses isolated synthetic identities. It does not grant
              access to another organization.
            </p>
            <ActionForm action={localSignIn} label="Open local workspace" />
          </div>
        )}
        <p className="muted">
          Your key stays in an HttpOnly session cookie. Expired or revoked membership requires
          signing in again.
        </p>
        <Link className="text-link" href="/settings#health">
          View service health →
        </Link>
      </section>
    </div>
  );
}
