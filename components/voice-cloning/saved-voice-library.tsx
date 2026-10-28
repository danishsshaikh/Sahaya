'use client';

import { useState } from 'react';
import { Check, Pencil, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PublicVoiceProfile, VoiceLibraryProviderId } from '@/lib/voice-cloning/types';

const PROVIDER_LABELS: Record<VoiceLibraryProviderId, string> = {
  chatterbox: 'Chatterbox',
  'qwen3-tts': 'Qwen3-TTS',
  'ming3-tts': 'Ming 3.0',
  sarvam: 'Sarvam',
  indicf5: 'IndicF5',
};

export function SavedVoiceLibrary({
  profiles,
  selectedProfileId,
  disabled = false,
  onSelect,
  onRename,
}: {
  profiles: PublicVoiceProfile[];
  selectedProfileId?: string;
  disabled?: boolean;
  onSelect: (profile: PublicVoiceProfile) => void | Promise<void>;
  onRename: (profile: PublicVoiceProfile, displayName: string) => void | Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  if (!profiles.length) {
    return (
      <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        No saved voices yet. Record or import an authorized reference to create one.
      </p>
    );
  }

  return (
    <div className="divide-y rounded-lg border" aria-label="Saved Voice Library">
      {profiles.map((profile) => {
        const selected = profile.id === selectedProfileId;
        const preview = profile.preview;
        const editing = editingId === profile.id;
        return (
          <div key={profile.id} className="space-y-2 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {editing ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = draftName.trim();
                      if (!name) return;
                      void onRename(profile, name);
                      setEditingId(null);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`Rename ${profile.displayName}`}
                      value={draftName}
                      maxLength={80}
                      onChange={(event) => setDraftName(event.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
                    />
                    <Button size="sm" type="submit" disabled={disabled || !draftName.trim()}>
                      Save
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <p className="truncate text-sm font-medium">{profile.displayName}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(profile.createdAt).toLocaleDateString()}
                      {profile.updatedAt !== profile.createdAt
                        ? ` · Updated ${new Date(profile.updatedAt).toLocaleDateString()}`
                        : ''}{' '}
                      ·{' '}
                      {profile.enrollmentSource === 'audio-import'
                        ? 'Imported audio'
                        : 'Microphone'}
                    </p>
                  </>
                )}
              </div>
              {!editing ? (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setEditingId(profile.id);
                      setDraftName(profile.displayName);
                    }}
                  >
                    <Pencil className="size-3.5" /> Rename
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    disabled={disabled || selected}
                    onClick={() => void onSelect(profile)}
                  >
                    {selected ? <Check className="size-3.5" /> : <Play className="size-3.5" />}
                    {selected ? 'Selected' : 'Select'}
                  </Button>
                </div>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Compatible:{' '}
              {(profile.compatibleProviders ?? []).map((id) => PROVIDER_LABELS[id]).join(', ') ||
                'No configured cloning provider'}
            </p>
            {preview ? (
              <div>
                <p className="mb-1 text-[11px] text-muted-foreground">Synthetic voice preview</p>
                <audio
                  controls
                  preload="none"
                  className="h-8 w-full"
                  src={`data:audio/${preview.format};base64,${preview.base64}`}
                />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">No saved synthetic preview.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
