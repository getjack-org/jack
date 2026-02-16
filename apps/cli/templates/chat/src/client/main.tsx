import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";

// biome-ignore lint/style/noNonNullAssertion: root element always exists in index.html
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
