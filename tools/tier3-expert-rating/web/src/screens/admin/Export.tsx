import { useId, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";

import type { Role } from "../../../../shared/api.ts";
import type { Overview } from "./model.ts";
import { ROLE_LABEL } from "./model.ts";

/** The export: by default the roles the analysis uses, or the study's only roles in a pilot. */
export function Export({ overview }: { overview: Overview }) {
  const id = useId();
  const present = (["main", "reserve", "pilot", "test"] as const).filter((role) =>
    overview.raters.some((rater) => rater.role === role),
  );
  const analysed = present.filter((role) => role === "main" || role === "reserve");
  const [roles, setRoles] = useState<Role[]>(analysed.length > 0 ? analysed : present);
  const query = roles.map((role) => `role=${role}`).join("&");
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        {present.map((role) => (
          <Field key={role} orientation="horizontal">
            <Checkbox
              id={`${id}-${role}`}
              checked={roles.includes(role)}
              onCheckedChange={(checked) =>
                setRoles((previous) =>
                  checked ? [...previous, role] : previous.filter((value) => value !== role),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${role}`}>{ROLE_LABEL[role]} raters</FieldLabel>
          </Field>
        ))}
      </div>
      <p className="m-0 text-sm text-muted-foreground">
        A ZIP with tidy CSV tables, the same data as JSON, the change log, and a codebook. Remove
        identifying details from free text before publishing.
      </p>
      <div>
        {roles.length > 0 && (
          <a className={buttonVariants()} href={`/api/admin/export.zip?${query}`} download>
            Download the export
          </a>
        )}
      </div>
    </div>
  );
}
