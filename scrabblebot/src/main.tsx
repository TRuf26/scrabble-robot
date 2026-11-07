import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";
import App from "./App";
import "./styles.css";

const clientId =
  import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID ?? "client_033TAMKV1cQuyRL7bndbQQ";

const oidcConfig = {
  authority: "https://auth.spacetimedb.com/oidc",
  client_id: clientId,
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  scope: "openid profile email",
  response_type: "code",
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.localStorage }),
};

// After the OIDC redirect, strip the ?code=&state= params from the URL.
function onSigninCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider {...oidcConfig} onSigninCallback={onSigninCallback}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
