import type { PackageDraft } from '../lib/draft';
import { emptyPackage } from '../lib/draft';
import { Field, scoped } from './Field';

interface Props {
  value: PackageDraft[];
  onChange: (v: PackageDraft[]) => void;
  errors: Record<string, string>;
  showDeclaredValue: boolean;
}

export function PackagesEditor({ value, onChange, errors, showDeclaredValue }: Props) {
  const update = (i: number, patch: Partial<PackageDraft>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-4">
      {errors._ && <p className="text-sm text-red-600">{errors._}</p>}
      {value.map((p, i) => {
        const e = scoped(String(i), errors);
        const numField = (key: keyof PackageDraft, label: string, step = '0.1') => (
          <Field label={label} error={e[key === 'declaredValueGhs' ? 'declaredValuePesewas' : key]}>
            {(props) => (
              <input
                {...props}
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step={step}
                value={p[key]}
                onChange={(ev) => update(i, { [key]: ev.target.value })}
              />
            )}
          </Field>
        );
        return (
          <div key={i} className="card space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Item {i + 1}</h3>
              {value.length > 1 && (
                <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
            <Field label="What is it?" error={e.description}>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  placeholder="e.g. Box of clothing, laptop, documents"
                  value={p.description}
                  onChange={(ev) => update(i, { description: ev.target.value })}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {numField('weightKg', 'Weight (kg)')}
              {numField('lengthCm', 'Length (cm)', '1')}
              {numField('widthCm', 'Width (cm)', '1')}
              {numField('heightCm', 'Height (cm)', '1')}
              {numField('quantity', 'Quantity', '1')}
            </div>
            {showDeclaredValue && <div className="sm:w-1/3">{numField('declaredValueGhs', 'Declared value (GH₵)', '1')}</div>}
          </div>
        );
      })}
      {value.length < 50 && (
        <button type="button" className="btn-secondary" onClick={() => onChange([...value, emptyPackage()])}>
          + Add another item
        </button>
      )}
    </div>
  );
}
