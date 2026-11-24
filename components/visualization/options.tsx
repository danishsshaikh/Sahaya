'use client';

import {
  VISUALIZATION_DIFFICULTIES,
  VISUALIZATION_STYLES,
  type VisualizationOptions,
} from '@openmaic/dsl';
import { Textarea } from '@/components/ui/textarea';

const selectClass = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm';
const labelClass = 'grid gap-1.5 text-xs font-medium';
const styleLabel = {
  automatic: 'Automatic',
  mathematical: 'Mathematical',
  conceptual: 'Conceptual',
  technical: 'Technical',
  spatial: 'Spatial / 3D',
  custom: 'Custom',
};
const difficultyLabel = {
  introductory: 'Introductory',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export function VisualizationOptionsFields({
  value,
  onChange,
  disabled,
}: {
  value?: VisualizationOptions;
  onChange: (options: VisualizationOptions) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-3" disabled={disabled}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Visualization style
          <select
            className={selectClass}
            value={value?.style ?? 'automatic'}
            onChange={(event) =>
              onChange({ ...value, style: event.target.value as VisualizationOptions['style'] })
            }
          >
            {VISUALIZATION_STYLES.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Depth
          <select
            className={selectClass}
            value={value?.difficulty ?? 'introductory'}
            onChange={(event) =>
              onChange({
                ...value,
                difficulty: event.target.value as VisualizationOptions['difficulty'],
              })
            }
          >
            {VISUALIZATION_DIFFICULTIES.map((difficulty) => (
              <option key={difficulty} value={difficulty}>
                {difficultyLabel[difficulty]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={labelClass}>
        Animation instructions
        <Textarea
          value={value?.instructions ?? ''}
          maxLength={1600}
          rows={2}
          placeholder="Describe what should move, change, or come into view."
          onChange={(event) => onChange({ ...value, instructions: event.target.value })}
        />
      </label>
    </fieldset>
  );
}
