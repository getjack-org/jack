import { useState, useEffect } from "react";

type GreetingStyle = "formal" | "fun" | "casual";

const styleEmojis: Record<GreetingStyle, string> = {
  formal: "🎩",
  fun: "🎉",
  casual: "👋",
};

const styleGradients: Record<GreetingStyle, string> = {
  formal: "from-slate-600 to-slate-800",
  fun: "from-pink-500 to-purple-600",
  casual: "from-blue-400 to-cyan-500",
};

export function GreetingWidget() {
  const [name, setName] = useState("Friend");
  const [style, setStyle] = useState<GreetingStyle>("casual");
  const [response, setResponse] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nameParam = params.get("name");
    const styleParam = params.get("style") as GreetingStyle | null;

    if (nameParam) setName(nameParam);
    if (styleParam && styleParam in styleEmojis) setStyle(styleParam);

    // Listen for messages from ChatGPT
    if (window.openai?.onMessage) {
      window.openai.onMessage((message: string) => {
        setResponse(message);
        setIsLoading(false);
      });
    }
  }, []);

  const handleGreet = async () => {
    setIsLoading(true);
    setResponse(null);

    if (window.openai?.callTool) {
      try {
        const result = await window.openai.callTool("get_greeting", {
          name,
          style,
        });
        setResponse(String(result));
      } catch (error) {
        setResponse("Oops! Something went wrong.");
      } finally {
        setIsLoading(false);
      }
    } else if (window.openai?.sendMessage) {
      window.openai.sendMessage(
        `Please greet ${name} in a ${style} style!`
      );
    } else {
      setResponse(`Hello ${name}! (Demo mode - no ChatGPT connection)`);
      setIsLoading(false);
    }
  };

  const emoji = styleEmojis[style];
  const gradient = styleGradients[style];

  return (
    <div className={`min-h-screen bg-gradient-to-br ${gradient} flex items-center justify-center p-4`}>
      <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <div className="text-center">
          <div className="text-6xl mb-4">{emoji}</div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">
            Hello, {name}!
          </h1>
          <p className="text-gray-600 mb-6">
            Style: <span className="font-semibold capitalize">{style}</span>
          </p>

          <button
            onClick={handleGreet}
            disabled={isLoading}
            className={`
              w-full py-3 px-6 rounded-xl font-semibold text-white
              transition-all duration-200 transform
              ${isLoading
                ? "bg-gray-400 cursor-not-allowed"
                : `bg-gradient-to-r ${gradient} hover:scale-105 hover:shadow-lg active:scale-95`
              }
            `}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Getting greeting...
              </span>
            ) : (
              "Get a Greeting from ChatGPT"
            )}
          </button>

          {response && (
            <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
              <p className="text-gray-700 italic">{response}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
