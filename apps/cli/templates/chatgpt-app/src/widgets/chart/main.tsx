import { createRoot } from "react-dom/client";
import { ChartWidget } from "./ChartWidget";
import "../../styles/widget.css";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<ChartWidget />);
}
