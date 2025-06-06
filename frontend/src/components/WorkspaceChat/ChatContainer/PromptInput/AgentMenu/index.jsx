import { useEffect, useRef, useState } from "react";
import { Tooltip } from "react-tooltip";
import { At } from "@phosphor-icons/react";
import { useIsAgentSessionActive } from "@/utils/chat/agent";
import { useTranslation } from "react-i18next";

export default function AvailableAgentsButton({ showing, setShowAgents }) {
  const { t } = useTranslation();
  const agentSessionActive = useIsAgentSessionActive();
  if (agentSessionActive) return null;
  return (
    <div
      id="agent-list-btn"
      data-tooltip-id="tooltip-agent-list-btn"
      data-tooltip-content={t("chat_window.agents")}
      aria-label={t("chat_window.agents")}
      onClick={() => setShowAgents(!showing)}
      className={`flex justify-center items-center cursor-pointer ${
        showing ? "!opacity-100" : ""
      }`}
    >
      <At
        color="var(--theme-sidebar-footer-icon-fill)"
        className={`w-[22px] h-[22px] pointer-events-none text-theme-text-primary opacity-60 hover:opacity-100 light:opacity-100 light:hover:opacity-60`}
      />
      <Tooltip
        id="tooltip-agent-list-btn"
        place="top"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
    </div>
  );
}

function AbilityTag({ text }) {
  return (
    <div className="px-2 bg-theme-action-menu-item-hover text-theme-text-secondary text-xs w-fit rounded-sm">
      <p>{text}</p>
    </div>
  );
}

export function AvailableAgents({
  showing,
  setShowing,
  sendCommand,
  promptRef,
}) {
  const formRef = useRef(null);
  const agentSessionActive = useIsAgentSessionActive();

  /*
   * @checklist-item
   * If the URL has the #agent hash, open the agent menu for the user
   * automatically when the component mounts.
   */
  useEffect(() => {
    if (window.location.hash === "#agent" && !showing) handleAgentClick();
  }, [promptRef.current]);

  useEffect(() => {
    function listenForOutsideClick() {
      if (!showing || !formRef.current) return false;
      document.addEventListener("click", closeIfOutside);
    }
    listenForOutsideClick();
  }, [showing, formRef.current]);

  const closeIfOutside = ({ target }) => {
    if (target.id === "agent-list-btn") return;
    const isOutside = !formRef?.current?.contains(target);
    if (!isOutside) return;
    setShowing(false);
  };

  const handleAgentClick = () => {
    setShowing(false);
    sendCommand("@agent ", false);
    promptRef?.current?.focus();
  };

  if (agentSessionActive) return null;
  return (
    <>
      <div hidden={!showing}>
        <div className="w-full flex justify-center absolute bottom-[130px] md:bottom-[150px] left-0 z-10 px-4">
          <div
            ref={formRef}
            className="w-[600px] p-2 bg-theme-action-menu-bg rounded-2xl shadow flex-col justify-center items-start gap-2.5 inline-flex"
          >
            <button
              onClick={handleAgentClick}
              className="border-none w-full hover:cursor-pointer hover:bg-theme-action-menu-item-hover px-2 py-2 rounded-xl flex flex-col justify-start group"
            >
              <div className="w-full flex-col text-left flex pointer-events-none">
                <div className="text-theme-text-primary text-sm">
                  <b>@agent</b> - the default agent for this workspace.
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <AbilityTag text="rag-search" />
                  <AbilityTag text="web-scraping" />
                  <AbilityTag text="web-browsing" />
                  <AbilityTag text="save-file-to-browser" />
                  <AbilityTag text="list-documents" />
                  <AbilityTag text="summarize-document" />
                  <AbilityTag text="chart-generation" />
                </div>
              </div>
            </button>
            <button
              type="button"
              disabled={true}
              className="w-full rounded-xl flex flex-col justify-start group"
            >
              <div className="w-full flex-col text-center flex pointer-events-none">
                <div className="text-theme-text-secondary text-xs italic">
                  custom agents are coming soon!
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export function useAvailableAgents() {
  const [showAgents, setShowAgents] = useState(false);
  return { showAgents, setShowAgents };
}
