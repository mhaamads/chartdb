import { Spinner } from '@/components/spinner/spinner';
import { Toaster } from '@/components/toast/toaster';
import { AlertProvider } from '@/context/alert-context/alert-provider';
import { CanvasProvider } from '@/context/canvas-context/canvas-provider';
import { ChartDBProvider } from '@/context/chartdb-context/chartdb-provider';
import { ConfigProvider } from '@/context/config-context/config-provider';
import { DiagramFilterProvider } from '@/context/diagram-filter-context/diagram-filter-provider';
import { DialogProvider } from '@/context/dialog-context/dialog-provider';
import { DiffProvider } from '@/context/diff-context/diff-provider';
import { ExportImageProvider } from '@/context/export-image-context/export-image-provider';
import { FullScreenLoaderProvider } from '@/context/full-screen-spinner-context/full-screen-spinner-provider';
import { HistoryProvider } from '@/context/history-context/history-provider';
import { RedoUndoStackProvider } from '@/context/history-context/redo-undo-stack-provider';
import { KeyboardShortcutsProvider } from '@/context/keyboard-shortcuts-context/keyboard-shortcuts-provider';
import { LayoutProvider } from '@/context/layout-context/layout-provider';
import { LocalConfigProvider } from '@/context/local-config-context/local-config-provider';
import { ThemeProvider } from '@/context/theme-context/theme-provider';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useChartDB } from '@/hooks/use-chartdb';
import { useDialog } from '@/hooks/use-dialog';
import { useLocalConfig } from '@/hooks/use-local-config';
import { HIDE_CHARTDB_CLOUD } from '@/lib/env';
import { ReactFlowProvider } from '@xyflow/react';
import React, { Suspense, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { TopNavbarMock } from './top-navbar/top-navbar-mock';
import { useDiagramLoader } from './use-diagram-loader';

const OPEN_STAR_US_AFTER_SECONDS = 30;
const SHOW_STAR_US_AGAIN_AFTER_DAYS = 1;

export const EditorDesktopLayoutLazy = React.lazy(
    () => import('./editor-desktop-layout')
);

export const EditorMobileLayoutLazy = React.lazy(
    () => import('./editor-mobile-layout')
);

const EditorPageComponent: React.FC = () => {
    const { diagramName, currentDiagram } = useChartDB();
    const { openStarUsDialog } = useDialog();
    const { isMd: isDesktop } = useBreakpoint('md');
    const { starUsDialogLastOpen, setStarUsDialogLastOpen, githubRepoOpened } =
        useLocalConfig();
    const { initialDiagram } = useDiagramLoader();

    useEffect(() => {
        if (HIDE_CHARTDB_CLOUD) {
            return;
        }

        if (!currentDiagram?.id || githubRepoOpened) {
            return;
        }

        if (
            new Date().getTime() - starUsDialogLastOpen >
            1000 * 60 * 60 * 24 * SHOW_STAR_US_AGAIN_AFTER_DAYS
        ) {
            const lastOpen = new Date().getTime();
            setStarUsDialogLastOpen(lastOpen);
            setTimeout(openStarUsDialog, OPEN_STAR_US_AFTER_SECONDS * 1000);
        }
    }, [
        currentDiagram?.id,
        githubRepoOpened,
        openStarUsDialog,
        setStarUsDialogLastOpen,
        starUsDialogLastOpen,
    ]);

    return (
        <>
            <Helmet>
                <title>
                    {diagramName
                        ? `ChartDB - ${diagramName} Diagram | Visualize Database Schemas`
                        : 'ChartDB - Create & Visualize Database Schema Diagrams'}
                </title>
            </Helmet>
            <section
                className={`bg-background ${isDesktop ? 'h-screen w-screen' : 'h-dvh w-dvw'} flex select-none flex-col overflow-x-hidden`}
            >
                <Suspense
                    fallback={
                        <>
                            <TopNavbarMock />
                            <div className="flex flex-1 items-center justify-center">
                                <Spinner
                                    size={isDesktop ? 'large' : 'medium'}
                                />
                            </div>
                        </>
                    }
                >
                    {isDesktop ? (
                        <EditorDesktopLayoutLazy
                            initialDiagram={initialDiagram}
                        />
                    ) : (
                        <EditorMobileLayoutLazy
                            initialDiagram={initialDiagram}
                        />
                    )}
                </Suspense>
            </section>
            <Toaster />
        </>
    );
};

export const EditorPage: React.FC = () => (
    <LocalConfigProvider>
        <ThemeProvider>
            <FullScreenLoaderProvider>
                <LayoutProvider>
                    <ConfigProvider>
                        <RedoUndoStackProvider>
                            <DiffProvider>
                                <ChartDBProvider>
                                    <DiagramFilterProvider>
                                        <HistoryProvider>
                                            <ReactFlowProvider>
                                                <CanvasProvider>
                                                    <ExportImageProvider>
                                                        <AlertProvider>
                                                            <DialogProvider>
                                                                <KeyboardShortcutsProvider>
                                                                    <EditorPageComponent />
                                                                </KeyboardShortcutsProvider>
                                                            </DialogProvider>
                                                        </AlertProvider>
                                                    </ExportImageProvider>
                                                </CanvasProvider>
                                            </ReactFlowProvider>
                                        </HistoryProvider>
                                    </DiagramFilterProvider>
                                </ChartDBProvider>
                            </DiffProvider>
                        </RedoUndoStackProvider>
                    </ConfigProvider>
                </LayoutProvider>
            </FullScreenLoaderProvider>
        </ThemeProvider>
    </LocalConfigProvider>
);
