/**
 * Runs the installed plugins for as long as the app is mounted and shows anything they ask to say.
 * Every toast is attributed to its plugin by name (17_PLUGIN_SDK.md §7.7: a plugin's message is
 * never mistaken for the host's).
 */

import { PasteToast } from '../capture/PasteToast';
import { usePlugins } from './usePlugins';

export function PluginNotices() {
  const { notice, dismissNotice } = usePlugins();
  return (
    <PasteToast
      message={notice === null ? null : `${notice.pluginName}: ${notice.message}`}
      onUndo={null}
      onImportList={null}
      onDismiss={dismissNotice}
    />
  );
}
