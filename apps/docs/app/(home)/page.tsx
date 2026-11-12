import { ArrowDown, ArrowRight, GitBranch, Terminal, TreePine } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { WaldMark } from "../../components/brand.js";
import { CopyCommand, Demo } from "../../components/demo.js";
import { WorktreeComparison } from "../../components/worktree-comparison.js";
import { asset, repository } from "../../lib/site.mjs";

export const metadata: Metadata = { alternates: { canonical: asset("/") } };

const createCommand = "wald create feature/search --tool code";

export default function Home() {
  return (
    <div className="wald-home">
      <section className="hero">
        <div className="page-width hero-grid">
          <div className="hero-copy">
            <p className="hero-kicker">
              <TreePine size={16} aria-hidden="true" /> Where Git worktrees grow
            </p>
            <h1>
              Git worktrees,
              <span className="hero-accent">ready for real work.</span>
            </h1>
            <p className="hero-lead">
              Keep your unfinished work open. wald creates and prepares a separate checkout for the
              next feature, hotfix, or coding agent.
            </p>
            <div className="wald-actions">
              <Link className="wald-button primary" href="/docs/getting-started">
                Get started <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <a className="wald-button secondary" href="#worktree-example">
                See how it works <ArrowDown size={17} aria-hidden="true" />
              </a>
            </div>
            <p className="hero-platform">
              Open source <span>·</span> macOS and Linux
            </p>
          </div>
          <Demo id="create" hero />
        </div>
      </section>

      <section className="page-width home-section example-section" id="worktree-example">
        <div className="section-intro">
          <h2>Keep the feature open. Fix the bug beside it.</h2>
          <p>
            A login bug just came in while you’re working on search. A Git worktree gives the hotfix
            its own files and staging area. Both folders share the same repository.
          </p>
          <Link className="text-link" href="/docs/worktrees">
            Why use worktrees? <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <div className="example-figure">
          <Image
            src={asset("/media/wald-worktrees.webp")}
            width={1280}
            height={853}
            sizes="(max-width: 800px) 100vw, 660px"
            alt="Independent Git worktrees growing from one shared repository."
          />
          <WorktreeComparison />
        </div>
      </section>

      <section className="setup-section">
        <div className="page-width home-section setup-grid">
          <div className="section-intro">
            <h2>Reuse your project setup with hooks.</h2>
            <p>
              Install dependencies and copy local settings after creating a worktree. Run project
              checks before removal. wald runs these hooks after you review and trust the
              configuration.
            </p>
            <Link className="text-link" href="/docs/project-setup">
              Configure lifecycle hooks <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <div className="setup-comparison">
            <div className="setup-manual">
              <h3>
                <GitBranch size={17} aria-hidden="true" /> Set up a Git worktree by hand
              </h3>
              <ol>
                <li>Choose the branch, base, and directory.</li>
                <li>Install dependencies and prepare local settings.</li>
                <li>Open the checkout in your editor or agent.</li>
              </ol>
            </div>
            <div className="setup-wald">
              <h3>
                <Terminal size={17} aria-hidden="true" /> Run wald with trusted project setup
              </h3>
              <div className="command-line">
                <code>
                  <span aria-hidden="true">❯ </span>
                  {createCommand}
                </code>
                <CopyCommand command={createCommand} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="agent-section">
        <div className="page-width home-section agent-grid">
          <div className="section-intro">
            <h2>Give each coding agent its own worktree.</h2>
            <p>
              One agent can work on the API while another builds the UI. They can edit, stage, and
              run checks in their own folders while sharing Git history.
            </p>
            <div className="agent-paths">
              <div>
                <code>feature-api/</code>
                <span>API changes</span>
              </div>
              <div>
                <code>feature-ui/</code>
                <span>UI changes</span>
              </div>
            </div>
            <p className="agent-note">
              Choose separate ports or databases where your project needs them.
            </p>
            <Link className="text-link" href="/docs/agent-workflows">
              Run two agents in parallel <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <Demo id="parallel" />
        </div>
      </section>

      <section className="page-width home-section finish-section">
        <div className="section-intro">
          <h2>Keep the code. Retire the checkout.</h2>
          <p>
            Copy a draft into a new worktree when it needs a different branch. When you’re done,
            review what wald will remove before confirming.
          </p>
          <Link className="text-link" href="/docs/finish">
            Hand off and finish work <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <div className="finish-grid">
          <Demo id="handoff" />
          <Demo id="cleanup" />
        </div>
      </section>

      <section className="page-width last-section">
        <div>
          <h2>Create your first worktree.</h2>
          <p>Start with a Git repository you already use.</p>
        </div>
        <Link className="wald-button primary" href="/docs/getting-started">
          Get started <ArrowRight size={17} aria-hidden="true" />
        </Link>
      </section>

      <footer className="page-width site-footer">
        <Link href="/" aria-label="wald home">
          <WaldMark />
        </Link>
        <nav aria-label="Footer">
          <Link href="/docs">Documentation</Link>
          <Link href="/docs/roadmap">Roadmap</Link>
          <a href={repository}>GitHub</a>
          <a href={`${repository}/blob/main/LICENSE`}>MIT license</a>
        </nav>
      </footer>
    </div>
  );
}
