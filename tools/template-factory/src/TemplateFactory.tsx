import {
  SmithersProvider,
  Claude,
  Phase,
  Step,
  While,
  Worktree,
  useSmithers,
} from "smithers-orchestrator";
import type { SmithersDB } from "smithers-orchestrator";
import type { TemplateIntent } from "./types";

// =============================================================================
// State Keys
// =============================================================================

export const STATE_KEYS = {
  specComplete: "factory:spec:complete",
  specContent: "factory:spec:content",
  templateName: "factory:template:name",
  implementComplete: "factory:impl:complete",
  typeCheckPassed: "factory:impl:typecheck",
  lintPassed: "factory:impl:lint",
  deployUrl: "factory:validate:url",
  validateComplete: "factory:validate:complete",
  finalized: "factory:finalized",
} as const;

// =============================================================================
// Props
// =============================================================================

export interface TemplateFactoryProps {
  db: SmithersDB;
  executionId: string;
  intent: TemplateIntent;
  templatesDir?: string;
  onComplete?: (result: { success: boolean; templateName?: string; error?: string }) => void;
}

// =============================================================================
// Main Workflow Component
// =============================================================================

export function TemplateFactory({
  db,
  executionId,
  intent,
  templatesDir = "./apps/cli/templates",
  onComplete,
}: TemplateFactoryProps) {
  return (
    <SmithersProvider db={db} executionId={executionId} maxIterations={100}>
      <TemplateFactoryWorkflow
        intent={intent}
        templatesDir={templatesDir}
        onComplete={onComplete}
      />
    </SmithersProvider>
  );
}

// =============================================================================
// Internal Workflow - Fully Autonomous
// =============================================================================

interface WorkflowProps {
  intent: TemplateIntent;
  templatesDir: string;
  onComplete?: TemplateFactoryProps["onComplete"];
}

function TemplateFactoryWorkflow({ intent, templatesDir, onComplete }: WorkflowProps) {
  const { db } = useSmithers();

  // Get spec content for later phases - read synchronously from state
  const specContent = db.state.get(STATE_KEYS.specContent) as string | undefined;

  // Extract template name from spec or intent
  const getTemplateName = (): string => {
    const stored = db.state.get(STATE_KEYS.templateName) as string | undefined;
    if (stored) return stored;

    // Generate from intent
    const safeName = intent.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);
    return safeName || "new-template";
  };

  const templateName = getTemplateName();

  return (
    <>
      {/* PHASE 1: SPEC - Claude creates the spec autonomously */}
      <Phase name="spec">
        <Step name="create-spec">
          <Claude
            model="sonnet"
            maxTurns={15}
            permissionMode="bypassPermissions"
            onFinished={({ output }) => {
              db.state.set(STATE_KEYS.specContent, output);

              // Extract template name from output
              const nameMatch =
                output.match(/Template Name:\s*["\`]?([a-z0-9-]+)["\`]?/i) ||
                output.match(/name["\s:]+["\`]?([a-z0-9-]+)["\`]?/i);
              if (nameMatch) {
                db.state.set(STATE_KEYS.templateName, nameMatch[1].toLowerCase());
              } else {
                db.state.set(STATE_KEYS.templateName, getTemplateName());
              }

              db.state.set(STATE_KEYS.specComplete, true);
            }}
          >
            {`
You are creating a specification for a new Jack CLI template.

User's request: "${intent.description}"

Create a template specification that includes:

1. **Template Name**: A short, kebab-case name (e.g., "astro-landing", "api-starter")
2. **Description**: What this template does and who it's for
3. **Tech Stack**: List the technologies (always include: Hono for API, Cloudflare Workers)
4. **Files to Create**:
   - package.json (with dependencies)
   - wrangler.jsonc (Cloudflare config)
   - src/index.ts (main entry point with Hono)
   - .jack.json (template metadata)
   - Any other necessary files
5. **API Endpoints**: List any routes the template should have
6. **Key Features**: Bullet points of what makes this template useful

Keep it simple and practical. This template will be deployed to Cloudflare Workers.

Output the spec in a clear markdown format. Start with:
Template Name: <name>
            `.trim()}
          </Claude>
        </Step>
      </Phase>

      {/* PHASES 2-4: All inside Worktree for proper cwd scoping */}
      <Phase name="implement">
        <Worktree branch={`template/${templateName}`} cleanup={false}>
          {/* STEP: Generate template files */}
          <Step name="generate-files">
            <Claude
              model="sonnet"
              maxTurns={30}
              permissionMode="bypassPermissions"
              onFinished={() => {
                db.state.set(STATE_KEYS.implementComplete, true);
              }}
            >
              {`
You are implementing a Jack CLI template based on this specification:

${specContent || "Specification not available - use the user's intent: " + intent.description}

Create all template files in: apps/cli/templates/${templateName}/

REQUIREMENTS:
1. Create ALL files using your Write tool
2. Use "jack-template" as placeholder for project name in package.json name field
3. The .jack.json file must have this structure:
   {
     "name": "${templateName}",
     "description": "<description from spec>",
     "capabilities": []
   }
4. wrangler.jsonc must include:
   - name: "jack-template"
   - main: "src/index.ts"
   - compatibility_date: "2024-01-01"
5. src/index.ts must export a Hono app as default
6. Add a health check endpoint at GET /api/health that returns { status: "ok" }

Create the files now. Be thorough - create every file needed for a working template.
              `.trim()}
            </Claude>
          </Step>

          {/* STEP: Type check */}
          <Step name="typecheck">
            <Claude
              model="sonnet"
              maxTurns={15}
              permissionMode="bypassPermissions"
              onFinished={({ output }) => {
                if (
                  output.toLowerCase().includes("no type errors") ||
                  output.includes("0 errors") ||
                  output.toLowerCase().includes("type check passed")
                ) {
                  db.state.set(STATE_KEYS.typeCheckPassed, true);
                }
              }}
            >
              {`
Run type checking on the template. First install dependencies, then run tsc:

cd apps/cli/templates/${templateName} && bun install && bun tsc --noEmit 2>&1

If there are type errors, fix them and run again until there are no errors.
When done, say "Type check passed - no type errors".
              `.trim()}
            </Claude>
          </Step>

          {/* STEP: Validate structure */}
          <Step name="validate-structure">
            <Claude
              model="sonnet"
              maxTurns={10}
              permissionMode="bypassPermissions"
              onFinished={({ output }) => {
                if (
                  output.toLowerCase().includes("validation passed") ||
                  output.toLowerCase().includes("template is valid")
                ) {
                  db.state.set(STATE_KEYS.validateComplete, true);
                }
              }}
            >
              {`
Validate the template structure at apps/cli/templates/${templateName}/

Check that these files exist and are valid:
1. package.json - has name "jack-template", has hono dependency
2. wrangler.jsonc - valid JSON, has main field
3. src/index.ts - exports default Hono app
4. .jack.json - has name and description

Use the Read tool to check each file.

If all checks pass, say "Validation passed - template is valid".
If any issues, fix them and re-check.
              `.trim()}
            </Claude>
          </Step>

          {/* STEP: Register template */}
          <Step name="register-template">
            <Claude model="sonnet" maxTurns={10} permissionMode="bypassPermissions">
              {`
Add the new template "${templateName}" to the BUILTIN_TEMPLATES array.

1. First read: apps/cli/src/templates/index.ts
2. Find the BUILTIN_TEMPLATES array (it's an array of strings like ["hello", "miniapp", ...])
3. Add "${templateName}" to the array
4. Use Edit to add the entry

Example: If array is ["hello", "miniapp"], change to ["hello", "miniapp", "${templateName}"]
              `.trim()}
            </Claude>
          </Step>

          {/* STEP: Commit */}
          <Step
            name="commit"
            onComplete={() => {
              db.state.set(STATE_KEYS.finalized, true);
              onComplete?.({ success: true, templateName });
            }}
          >
            <Claude model="sonnet" maxTurns={8} permissionMode="bypassPermissions">
              {`
Commit all changes in this worktree.

1. Run: git status
2. Stage template files: git add apps/cli/templates/${templateName}/
3. Stage the index: git add apps/cli/src/templates/index.ts
4. Commit: git commit -m "feat: add ${templateName} template"

Show the git log after committing to confirm success.
              `.trim()}
            </Claude>
          </Step>
        </Worktree>
      </Phase>
    </>
  );
}
