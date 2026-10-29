import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { completeCognitoSignIn } from "../../lib/auth";

export const Route = createFileRoute("/auth/callback")({ component: Callback });

function Callback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    completeCognitoSignIn(p.get("code") ?? "", p.get("state") ?? "").then(
      () => {
        window.location.assign("/");
      },
      (e) => setError(String(e instanceof Error ? e.message : e)),
    );
  }, [navigate]);
  return <p className="text-sm text-slate-600">{error ?? "Se finalizează autentificarea…"}</p>;
}
