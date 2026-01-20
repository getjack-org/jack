import { useState, useEffect } from "react";

// Page imports
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import PricingPage from "./pages/PricingPage";
import DashboardPage from "./pages/DashboardPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import { ProtectedRoute } from "./components/ProtectedRoute";

type Route = "/" | "/login" | "/signup" | "/pricing" | "/dashboard" | "/forgot-password" | "/reset-password";

function getRouteFromHash(): Route {
	const hash = window.location.hash.split("?")[0].slice(1) || "/";
	const validRoutes: Route[] = ["/", "/login", "/signup", "/pricing", "/dashboard", "/forgot-password", "/reset-password"];
	return validRoutes.includes(hash as Route) ? (hash as Route) : "/";
}

export default function App() {
	const [route, setRoute] = useState<Route>(getRouteFromHash);

	useEffect(() => {
		const handleHashChange = () => {
			setRoute(getRouteFromHash());
		};

		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, []);

	const navigate = (newRoute: Route) => {
		window.location.hash = newRoute;
	};

	const renderPage = () => {
		switch (route) {
			case "/":
				return <HomePage navigate={navigate} />;
			case "/login":
				return <LoginPage navigate={navigate} />;
			case "/signup":
				return <SignupPage navigate={navigate} />;
			case "/pricing":
				return <PricingPage navigate={navigate} />;
			case "/forgot-password":
				return <ForgotPasswordPage navigate={navigate} />;
			case "/reset-password":
				return <ResetPasswordPage navigate={navigate} />;
			case "/dashboard":
				return (
					<ProtectedRoute navigate={navigate}>
						<DashboardPage navigate={navigate} />
					</ProtectedRoute>
				);
			default:
				return <HomePage navigate={navigate} />;
		}
	};

	return <div className="min-h-screen">{renderPage()}</div>;
}
