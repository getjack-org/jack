import { useState, useEffect } from "react";

interface DataPoint {
  label: string;
  value: number;
  color?: string;
}

const defaultData: DataPoint[] = [
  { label: "React", value: 85 },
  { label: "Vue", value: 70 },
  { label: "Angular", value: 55 },
  { label: "Svelte", value: 45 },
  { label: "Solid", value: 30 },
];

const barGradients = [
  "from-purple-500 to-pink-500",
  "from-blue-500 to-cyan-500",
  "from-green-500 to-emerald-500",
  "from-orange-500 to-yellow-500",
  "from-red-500 to-rose-500",
  "from-indigo-500 to-violet-500",
];

export function ChartWidget() {
  const [data, setData] = useState<DataPoint[]>(defaultData);
  const [title, setTitle] = useState("Framework Popularity");
  const [selectedBar, setSelectedBar] = useState<DataPoint | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const dataParam = params.get("data");
    const titleParam = params.get("title");

    if (titleParam) setTitle(decodeURIComponent(titleParam));

    if (dataParam) {
      try {
        const parsedData = JSON.parse(decodeURIComponent(dataParam));
        if (Array.isArray(parsedData)) {
          setData(parsedData);
        }
      } catch (e) {
        console.error("Failed to parse data parameter:", e);
      }
    }

    // Listen for messages from ChatGPT
    if (window.openai?.onMessage) {
      window.openai.onMessage((message: string) => {
        setResponse(message);
        setIsLoading(false);
      });
    }
  }, []);

  const maxValue = Math.max(...data.map((d) => d.value));

  const handleBarClick = async (item: DataPoint) => {
    setSelectedBar(item);
    setIsLoading(true);
    setResponse(null);

    const question = `Tell me more about ${item.label} which has a value of ${item.value} in the "${title}" chart.`;

    if (window.openai?.sendMessage) {
      window.openai.sendMessage(question);
    } else {
      // Demo mode
      setResponse(
        `${item.label} has a value of ${item.value}. (Demo mode - no ChatGPT connection)`
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-900 to-gray-900 flex items-center justify-center p-4">
      <div className="bg-gray-800/80 backdrop-blur-sm rounded-2xl shadow-2xl p-8 max-w-2xl w-full border border-gray-700">
        <h1 className="text-2xl font-bold text-white mb-6 text-center">
          {title}
        </h1>

        <div className="space-y-4">
          {data.map((item, index) => {
            const percentage = (item.value / maxValue) * 100;
            const gradient = barGradients[index % barGradients.length];
            const isSelected = selectedBar?.label === item.label;

            return (
              <div
                key={item.label}
                className={`
                  group cursor-pointer transition-all duration-200
                  ${isSelected ? "scale-[1.02]" : "hover:scale-[1.01]"}
                `}
                onClick={() => handleBarClick(item)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-gray-300"}`}>
                    {item.label}
                  </span>
                  <span className={`text-sm ${isSelected ? "text-white" : "text-gray-400"}`}>
                    {item.value}
                  </span>
                </div>
                <div className="h-8 bg-gray-700/50 rounded-lg overflow-hidden">
                  <div
                    className={`
                      h-full bg-gradient-to-r ${gradient} rounded-lg
                      transition-all duration-500 ease-out
                      ${isSelected ? "shadow-lg shadow-purple-500/30" : ""}
                      group-hover:brightness-110
                    `}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-gray-500 text-sm mt-6 text-center">
          Click a bar to ask ChatGPT about it
        </p>

        {(isLoading || response) && (
          <div className={`
            mt-6 p-4 rounded-xl border
            ${isLoading
              ? "bg-gray-700/50 border-gray-600"
              : "bg-gradient-to-r from-purple-900/30 to-pink-900/30 border-purple-500/30"
            }
          `}>
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 text-gray-400">
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
                <span>Asking ChatGPT...</span>
              </div>
            ) : (
              <div>
                {selectedBar && (
                  <p className="text-purple-300 text-sm font-medium mb-2">
                    About {selectedBar.label}:
                  </p>
                )}
                <p className="text-gray-300">{response}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
