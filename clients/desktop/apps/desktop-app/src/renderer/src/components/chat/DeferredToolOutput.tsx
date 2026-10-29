import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import type { ChatToolOutputResponse } from '@canopy/desktop-shared/types';
import { DeferredTextOutput } from '@canopy/ui-shared/components';

export type ToolOutputReader = (
  messageId: string,
  toolUseId: string,
  reference: PersistedToolOutputReference,
  offset: number,
  signal: AbortSignal,
) => Promise<ChatToolOutputResponse>;
export const ToolOutputReaderContext = createContext<ToolOutputReader | null>(
  null,
);

interface DeferredToolOutputProps {
  reference: PersistedToolOutputReference;
  preview: string;
  messageId: string;
  toolUseId: string;
}

export const DeferredToolOutput = memo(function DeferredToolOutput({
  reference,
  preview,
  messageId,
  toolUseId,
}: DeferredToolOutputProps): JSX.Element {
  const read = useContext(ToolOutputReaderContext);
  const request = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const requestedPage = useRef({ offset: 0, position: 0 });
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState<ChatToolOutputResponse>();
  const [offsets, setOffsets] = useState([0]);
  const [position, setPosition] = useState(0);
  useEffect(() => {
    request.current += 1;
    setOpened(false);
    setLoading(false);
    setError(undefined);
    setPage(undefined);
    setOffsets([0]);
    setPosition(0);
    return (): void => {
      request.current += 1;
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [reference.artifactId, read]);
  async function load(offset: number, nextPosition: number): Promise<void> {
    const token = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    requestedPage.current = { offset, position: nextPosition };
    setOpened(true);
    setLoading(true);
    setError(undefined);
    try {
      if (!read) throw new Error("Couldn't load full output in this view.");
      const result = await read(
        messageId,
        toolUseId,
        reference,
        offset,
        nextController.signal,
      );
      if (request.current !== token) return;
      setPage(result);
      setPosition(nextPosition);
      setOffsets((current) => [...current.slice(0, nextPosition), offset]);
    } catch (failure) {
      if (request.current === token)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === token) setLoading(false);
    }
  }
  return (
    <DeferredTextOutput
      preview={preview}
      text={page?.text}
      opened={opened}
      loading={loading}
      error={error}
      hasPrevious={position > 0}
      hasNext={page?.nextOffset !== undefined}
      onOpen={() => {
        void load(0, 0);
      }}
      onPrevious={() => {
        void load(offsets[position - 1], position - 1);
      }}
      onNext={() => {
        if (page?.nextOffset !== undefined)
          void load(page.nextOffset, position + 1);
      }}
      onRetry={() => {
        void load(requestedPage.current.offset, requestedPage.current.position);
      }}
      onClose={() => {
        request.current += 1;
        controller.current?.abort();
        controller.current = undefined;
        setOpened(false);
        setPage(undefined);
        setLoading(false);
        setError(undefined);
      }}
    />
  );
});
