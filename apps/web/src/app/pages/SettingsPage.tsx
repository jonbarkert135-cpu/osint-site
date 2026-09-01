import { AiSettingsSection } from '../../settings/AiSettingsSection.tsx';
import { localOnly } from '../../mode/appMode.ts';

export default function SettingsPage() {
  return (
    <section className="nx-stack nx-auth-card">
      <h2>Settings</h2>
      {localOnly ? (
        <p className="nx-muted">
          AI settings live on the server. This build runs local-only, so there is nothing to
          configure here.
        </p>
      ) : (
        <AiSettingsSection />
      )}
      <p className="nx-muted">Account and appearance settings arrive in later phases.</p>
    </section>
  );
}
