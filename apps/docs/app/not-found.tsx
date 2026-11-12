import Link from "next/link";
import { WaldMark } from "../components/brand.js";

export default function NotFound() {
  return (
    <main className="not-found">
      <WaldMark />
      <h1>Page not found</h1>
      <p>Find a guide or command in the wald documentation.</p>
      <Link className="wald-button primary" href="/docs">
        Open the docs
      </Link>
    </main>
  );
}
