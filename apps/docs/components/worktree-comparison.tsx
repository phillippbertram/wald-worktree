"use client";

import { FolderGit2, GitBranch } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { WorkspaceMap } from "./demo.js";

export function WorktreeComparison() {
  const [separate, setSeparate] = useState(true);
  const reducedMotion = useReducedMotion();
  return (
    <div className="comparison">
      <fieldset className="comparison-mode">
        <legend className="sr-only">Compare workspaces</legend>
        <button type="button" aria-pressed={!separate} onClick={() => setSeparate(false)}>
          <GitBranch size={16} aria-hidden="true" /> One checkout
        </button>
        <button type="button" aria-pressed={separate} onClick={() => setSeparate(true)}>
          <FolderGit2 size={16} aria-hidden="true" /> Two worktrees
        </button>
      </fieldset>
      <motion.p
        key={String(separate)}
        initial={{ opacity: reducedMotion ? 1 : 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.25 }}
      >
        {separate
          ? "The hotfix gets a fresh checkout. Your search files and staging area stay where they are."
          : "Switching branches reuses the same folder. Put away any changes that would conflict with the hotfix."}
      </motion.p>
      <WorkspaceMap
        checkouts={
          separate
            ? [
                { name: "feature-search/", status: "Unfinished changes" },
                { name: "hotfix-login/", status: "Fresh checkout" },
              ]
            : [{ name: "canopy/", status: "One branch at a time" }]
        }
        rootLabel="One Git repository"
      />
    </div>
  );
}
