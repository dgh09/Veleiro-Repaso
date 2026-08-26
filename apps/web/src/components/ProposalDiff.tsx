import type { ProposalPayload } from "@veleiro/shared";

/**
 * What this change would actually do, field by field.
 *
 * SPEC: "a readable diff of what would change (field-by-field, not a raw JSON
 * dump)". The reason is the whole premise of the product - a consultant is
 * being asked to take responsibility for a change, and nobody can take
 * responsibility for a blob of JSON they skimmed. Every payload variant is
 * rendered by hand here so that adding a change type without deciding how a
 * human reads it is a type error rather than an oversight.
 */

interface Line {
  label: string;
  value: string;
  /** Marks the rows that carry the risk, so the eye lands on them. */
  emphasis?: boolean;
}

function lineFor(payload: ProposalPayload): { summary: string; lines: Line[] } {
  switch (payload.changeType) {
    case "create_object":
      return {
        summary: `Create a new object called ${payload.label}`,
        lines: [
          { label: "API name", value: payload.objectName },
          { label: "Label", value: payload.label },
          { label: "Description", value: payload.description ?? "—" },
        ],
      };

    case "create_field":
      return {
        summary: `Add a ${payload.fieldType} field to ${payload.objectName}`,
        lines: [
          { label: "Object", value: payload.objectName },
          { label: "API name", value: payload.fieldName },
          { label: "Label", value: payload.label },
          { label: "Type", value: payload.fieldType },
          { label: "Required", value: payload.required ? "Yes" : "No" },
          {
            label: "Picklist values",
            value:
              payload.picklistValues === null
                ? "—"
                : payload.picklistValues.join(", "),
          },
        ],
      };

    case "create_validation_rule":
      return {
        summary: `Block saves on ${payload.objectName} that fail a new rule`,
        lines: [
          { label: "Object", value: payload.objectName },
          { label: "Rule name", value: payload.ruleName },
          { label: "Blocks saving when", value: payload.condition, emphasis: true },
          { label: "Error shown", value: payload.errorMessage },
        ],
      };

    case "update_field": {
      const changes: Line[] = [];

      if (payload.newFieldType !== null) {
        // The destructive one. Existing values have to be coerced or dropped.
        changes.push({
          label: "Change type to",
          value: payload.newFieldType,
          emphasis: true,
        });
      }
      if (payload.newRequired !== null) {
        changes.push({
          label: "Required",
          value: payload.newRequired ? "Yes" : "No",
        });
      }
      if (payload.newLabel !== null) {
        changes.push({ label: "Rename label to", value: payload.newLabel });
      }
      if (payload.newPicklistValues !== null) {
        changes.push({
          label: "Picklist values",
          value: payload.newPicklistValues.join(", "),
        });
      }

      return {
        summary: `Modify the existing field ${payload.objectName}.${payload.fieldName}`,
        lines: [
          { label: "Object", value: payload.objectName },
          { label: "Field", value: payload.fieldName },
          ...(changes.length > 0
            ? changes
            : // Worth showing rather than hiding: a proposal that changes
              // nothing is a reason to reject, and silence would look like a
              // rendering bug instead.
              [{ label: "Changes", value: "None specified" }]),
        ],
      };
    }
  }
}

export function ProposalDiff({ payload }: { payload: ProposalPayload }) {
  const { summary, lines } = lineFor(payload);

  return (
    <div>
      <p className="text-sm font-medium text-neutral-900">{summary}</p>
      <dl className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200">
        {lines.map((line) => (
          <div key={line.label} className="grid grid-cols-3 gap-2 px-3 py-2 text-xs">
            <dt className="text-neutral-600">{line.label}</dt>
            <dd
              className={`col-span-2 font-mono break-words ${
                line.emphasis ? "font-semibold text-red-800" : "text-neutral-900"
              }`}
            >
              {line.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
