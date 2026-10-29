/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LogOut01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { BrandLogo, HeaderBrand } from "@/components/app/BrandMark";
import { api } from "@/lib/api";
import { BRAND_NAME, PRODUCT_NAME } from "@/lib/brand";
import { AUTH_MODE, getSession, setActiveRole, signOut } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/labels";
import type { Role } from "@/lib/types";
import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: `${PRODUCT_NAME} · ${BRAND_NAME}` }],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" },
      { rel: "stylesheet", href: css },
    ],
  }),
  shellComponent: Shell,
  component: Layout,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="ro">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-secondary text-primary antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

const ROLES = Object.keys(ROLE_LABEL) as Role[];

function Layout() {
  const [me, setMe] = useState<{ username: string; roles: Role[] }>();
  const [role, setRole] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const s = getSession();
    setReady(true);
    if (!s) return;
    setRole(s.role);
    api.get<{ username: string; roles: Role[] }>("/me").then(
      (m) => {
        setMe(m);
        if (!s.role || !m.roles.includes(s.role as Role)) {
          setActiveRole(m.roles[0]!);
          setRole(m.roles[0]);
        }
      },
      () => undefined,
    );
  }, []);

  const onCallback = typeof window !== "undefined" && window.location.pathname.startsWith("/auth/");
  if (!ready) return null;
  if (!getSession() && !onCallback) return <SignIn />;

  return (
    <div className="flex min-h-screen flex-col">
      {/* black header with yellow accents (bank colour scheme) */}
      <header className="border-b-4 border-brand-solid bg-black">
        <div className="mx-auto flex max-w-container items-center gap-8 px-4 py-3 md:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <HeaderBrand />
          </Link>
          <nav className="flex items-center gap-1">
            {[
              { to: "/", label: "Dosare", exact: true },
              { to: "/cases/new", label: "Dosar nou", exact: false },
            ].map((l) => (
              <Link
                key={l.to}
                to={l.to}
                activeOptions={{ exact: l.exact }}
                // TanStack Router marks the current link with data-status="active"
                className="rounded-md px-3 py-2 text-sm font-semibold text-white/75 transition hover:bg-white/10 hover:text-white data-[status=active]:bg-brand-solid data-[status=active]:text-black"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {me && me.roles.length > 1 ? (
              <div className="w-52">
                <Select
                  aria-label="Rol activ"
                  size="sm"
                  selectedKey={role ?? null}
                  onSelectionChange={(k) => {
                    setActiveRole(String(k));
                    window.location.reload();
                  }}
                  items={me.roles.map((r) => ({ id: r, label: ROLE_LABEL[r] }))}
                >
                  {(item) => <Select.Item id={item.id} label={item.label} />}
                </Select>
              </div>
            ) : (
              role && <span className="text-sm font-medium text-white">{ROLE_LABEL[role as Role]}</span>
            )}
            {me && <span className="hidden text-sm text-white/70 md:inline">{me.username}</span>}
            <Button color="tertiary" size="sm" iconLeading={LogOut01} onPress={signOut} className="text-white/80 hover:bg-white/10 hover:text-white *:data-icon:text-white/60 hover:*:data-icon:text-white">
              Ieșire
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-container flex-1 px-4 py-8 md:px-8">
        <Outlet />
      </main>
      <footer className="border-t border-secondary bg-primary py-4 text-center text-xs text-tertiary">
        Sistemul AI detectează, explică și recomandă. Decizia finală aparține exclusiv ofițerului bancar (Regulamentul UE 2024/1689, art. 14).
      </footer>
    </div>
  );
}

function SignIn() {
  const [user, setUser] = useState("ana.ionescu");
  const [roles, setRoles] = useState<Role[]>(["credit_officer"]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl bg-primary p-8 shadow-lg ring-1 ring-secondary">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandLogo height={44} />
          <h1 className="mt-6 text-display-xs font-semibold text-primary">{PRODUCT_NAME}</h1>
          <p className="mt-1 text-md text-tertiary">Autentificare personal bancar</p>
        </div>
        {AUTH_MODE === "cognito" ? (
          <Button size="lg" className="w-full" onPress={() => import("@/lib/auth").then((m) => m.startCognitoSignIn())}>
            Autentificare cu contul de angajat
          </Button>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              import("@/lib/auth").then((m) => {
                m.devSignIn(user, roles);
                window.location.reload();
              });
            }}
          >
            <p className="rounded-lg bg-warning-primary px-3 py-2 text-xs text-warning-primary">Mod dezvoltare: autentificare locală, fără Cognito.</p>
            <Input label="Utilizator" value={user} onChange={setUser} isRequired />
            <div className="flex flex-col gap-3">
              <span className="text-sm font-medium text-secondary">Roluri</span>
              {ROLES.map((r) => (
                <Checkbox key={r} label={ROLE_LABEL[r]} isSelected={roles.includes(r)} onChange={(v) => setRoles(v ? [...roles, r] : roles.filter((x) => x !== r))} />
              ))}
            </div>
            <Button type="submit" size="lg" isDisabled={!roles.length} className="w-full">
              Intră
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
