import { pathToFileURL } from 'node:url';
import { listPublicUsers, type PublicAuthUser } from '@/lib/auth/server';
import { activateVoiceProfile, listVoiceProfiles } from '@/lib/voice-cloning/storage';
import { compatibleVoiceProviders, type VoiceProfile } from '@/lib/voice-cloning/types';

interface Dependencies {
  listUsers: () => Promise<PublicAuthUser[]>;
  listProfiles: (ownerId: string) => Promise<VoiceProfile[]>;
  activate: (ownerId: string, profileId: string) => Promise<VoiceProfile>;
}

interface Output {
  log(message?: string): void;
  error(message?: string): void;
}

const defaultDependencies: Dependencies = {
  listUsers: listPublicUsers,
  listProfiles: (ownerId) => listVoiceProfiles(ownerId),
  activate: activateVoiceProfile,
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

async function resolveOwner(
  userValue: string | undefined,
  dependencies: Dependencies,
): Promise<PublicAuthUser> {
  if (!userValue) throw new Error('Provide --user with the faculty email address or user ID.');
  const normalized = userValue.toLowerCase();
  const user = (await dependencies.listUsers()).find(
    (candidate) => candidate.id === userValue || candidate.email.toLowerCase() === normalized,
  );
  if (!user) throw new Error('The requested Sahaya user was not found.');
  if (user.status !== 'active') throw new Error('The requested Sahaya user is not active.');
  return user;
}

export async function runTeachingVoiceProfileCli(
  args: string[],
  output: Output = console,
  dependencies: Dependencies = defaultDependencies,
): Promise<number> {
  try {
    const command = args[0];
    if (command !== 'list' && command !== 'activate') {
      throw new Error(
        'Usage: pnpm voice-profile <list|activate> --user <email-or-id> [--profile <profile-id>]',
      );
    }
    const owner = await resolveOwner(option(args, '--user'), dependencies);
    if (command === 'list') {
      const profiles = await dependencies.listProfiles(owner.id);
      output.log(`Saved voices for ${owner.email} (${owner.id})`);
      if (!profiles.length) {
        output.log('No saved voice profiles were found.');
        return 0;
      }
      for (const profile of profiles) {
        const providers = compatibleVoiceProviders(profile).join(', ') || 'none';
        output.log(
          [
            profile.id,
            `created=${profile.createdAt}`,
            `updated=${profile.updatedAt}`,
            `status=${profile.status}`,
            `language=${profile.language}`,
            `providers=${providers}`,
            `name=${JSON.stringify(profile.displayName)}`,
          ].join('  '),
        );
      }
      return 0;
    }

    const profileId = option(args, '--profile');
    if (!profileId) throw new Error('Provide --profile with the saved voice profile ID.');
    const profile = await dependencies.activate(owner.id, profileId);
    output.log(
      `Active Teaching Voice set to ${profile.id} for ${owner.email}. Existing course bindings were not changed.`,
    );
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : 'Teaching Voice command failed.');
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runTeachingVoiceProfileCli(process.argv.slice(2));
}
