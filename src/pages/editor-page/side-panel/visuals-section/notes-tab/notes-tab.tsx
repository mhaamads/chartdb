import React, { useCallback, useMemo } from 'react';
import { Button } from '@/components/button/button';
import { Scan, StickyNote, X } from 'lucide-react';
import { Input } from '@/components/input/input';
import type { Note } from '@/lib/domain/note';
import type { Area } from '@/lib/domain/area';
import { getTableDimensions, type DBTable } from '@/lib/domain/db-table';
import { useChartDB } from '@/hooks/use-chartdb';
import { useLayout } from '@/hooks/use-layout';
import { EmptyState } from '@/components/empty-state/empty-state';
import { ScrollArea } from '@/components/scroll-area/scroll-area';
import { useTranslation } from 'react-i18next';
import { useViewport } from '@xyflow/react';
import { NotesList } from './notes-list/notes-list';
import { useAlert } from '@/context/alert-context/alert-context';
import { colorOptions, defaultNoteColor } from '@/lib/colors';

export interface NotesTabProps {}

const NOTE_GAP = 24;
const NOTE_MIN_WIDTH = 200;
const NOTE_MIN_HEIGHT = 150;

interface NoteRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const overlaps = (a: NoteRect, b: NoteRect) =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;

const areaDistance = (note: NoteRect, area: Area) => {
    const areaRight = area.x + area.width;
    const areaBottom = area.y + area.height;
    const noteRight = note.x + note.width;
    const noteBottom = note.y + note.height;
    const horizontal = Math.max(area.x - noteRight, note.x - areaRight, 0);
    const vertical = Math.max(area.y - noteBottom, note.y - areaBottom, 0);

    return Math.hypot(horizontal, vertical);
};

const findNoteArea = (
    note: NoteRect,
    areas: Area[]
): { area: Area; inside: boolean } | undefined => {
    // ponytail: infer legacy links spatially; persist target metadata if semantic links become required.
    const centerX = note.x + note.width / 2;
    const centerY = note.y + note.height / 2;
    const orderedAreas = [...areas].sort(
        (a, b) => (b.order ?? 0) - (a.order ?? 0)
    );
    const containingArea = orderedAreas.find(
        (area) =>
            centerX >= area.x &&
            centerX <= area.x + area.width &&
            centerY >= area.y &&
            centerY <= area.y + area.height
    );
    if (containingArea) return { area: containingArea, inside: true };

    const nearbyArea = orderedAreas
        .map((area) => ({ area, distance: areaDistance(note, area) }))
        .filter(({ distance }) => distance <= NOTE_GAP * 2)
        .sort((a, b) => a.distance - b.distance)[0];
    return nearbyArea ? { area: nearbyArea.area, inside: false } : undefined;
};

const findNotePosition = ({
    base,
    note,
    blockers,
    area,
}: {
    base: { x: number; y: number };
    note: NoteRect;
    blockers: NoteRect[];
    area?: Area;
}): { x: number; y: number } | null => {
    // ponytail: bounded 500-candidate scan; use a spatial index only for much larger diagrams.
    for (let row = 0; row < 50; row += 1) {
        for (let column = 0; column < 10; column += 1) {
            const candidate = {
                x: base.x + column * (note.width + NOTE_GAP),
                y: base.y + row * (note.height + NOTE_GAP),
                width: note.width,
                height: note.height,
            };
            if (
                area &&
                (candidate.x < area.x + 16 ||
                    candidate.y < area.y + 40 ||
                    candidate.x + candidate.width > area.x + area.width - 16 ||
                    candidate.y + candidate.height > area.y + area.height - 16)
            ) {
                continue;
            }
            if (!blockers.some((blocker) => overlaps(candidate, blocker))) {
                return { x: candidate.x, y: candidate.y };
            }
        }
    }
    return null;
};

const getTableRect = (table: DBTable): NoteRect => ({
    x: table.x,
    y: table.y,
    ...getTableDimensions(table),
});

export const NotesTab: React.FC<NotesTabProps> = () => {
    const { areas, createNote, notes, readonly, tables, updateNote } =
        useChartDB();
    const viewport = useViewport();
    const { t } = useTranslation();
    const { openNoteFromSidebar } = useLayout();
    const { showAlert } = useAlert();
    const [filterText, setFilterText] = React.useState('');
    const filterInputRef = React.useRef<HTMLInputElement>(null);

    const filteredNotes = useMemo(() => {
        const filterNoteContent: (note: Note) => boolean = (note) =>
            !filterText?.trim?.() ||
            note.content.toLowerCase().includes(filterText.toLowerCase());

        return notes.filter(filterNoteContent);
    }, [notes, filterText]);

    const createNoteWithLocation = useCallback(async () => {
        const padding = 80;
        const centerX = -viewport.x / viewport.zoom + padding / viewport.zoom;
        const centerY = -viewport.y / viewport.zoom + padding / viewport.zoom;
        const note = await createNote({
            x: centerX,
            y: centerY,
        });
        if (openNoteFromSidebar) {
            openNoteFromSidebar(note.id);
        }
    }, [
        createNote,
        openNoteFromSidebar,
        viewport.x,
        viewport.y,
        viewport.zoom,
    ]);

    const handleCreateNote = useCallback(async () => {
        setFilterText('');
        createNoteWithLocation();
    }, [createNoteWithLocation, setFilterText]);

    const handleClearFilter = useCallback(() => {
        setFilterText('');
    }, []);

    const repairNoteLayout = useCallback(async () => {
        if (readonly || notes.length === 0) return;

        const associations = new Map<string, { area: Area; inside: boolean }>();
        const noteRects = new Map<string, NoteRect>();
        notes.forEach((note) => {
            const rect = {
                x: Number.isFinite(note.x) ? note.x : 0,
                y: Number.isFinite(note.y) ? note.y : 0,
                width:
                    Number.isFinite(note.width) && note.width >= NOTE_MIN_WIDTH
                        ? note.width
                        : NOTE_MIN_WIDTH,
                height:
                    Number.isFinite(note.height) &&
                    note.height >= NOTE_MIN_HEIGHT
                        ? note.height
                        : NOTE_MIN_HEIGHT,
            };
            noteRects.set(note.id, rect);
            const association = findNoteArea(rect, areas);
            if (association) associations.set(note.id, association);
        });

        const associatedIds = new Set(associations.keys());
        const duplicateIds = new Set<string>();
        notes.forEach((note, index) => {
            const rect = noteRects.get(note.id)!;
            if (
                notes
                    .slice(0, index)
                    .some((previous) =>
                        overlaps(rect, noteRects.get(previous.id)!)
                    )
            ) {
                duplicateIds.add(note.id);
            }
        });
        const tableRects = tables.map(getTableRect);
        const areaRects = areas.map((area) => ({
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
        }));
        const orphanBase = {
            x:
                Math.max(
                    0,
                    ...areas.map((area) => area.x + area.width),
                    ...tables.map((table) => {
                        const { width } = getTableDimensions(table);
                        return table.x + width;
                    })
                ) + NOTE_GAP,
            y:
                Math.max(
                    0,
                    ...areas.map((area) => area.y + area.height),
                    ...tables.map((table) => {
                        const { height } = getTableDimensions(table);
                        return table.y + height;
                    })
                ) + NOTE_GAP,
        };
        const occupied = notes
            .filter(
                (note) =>
                    !associatedIds.has(note.id) && !duplicateIds.has(note.id)
            )
            .map((note) => noteRects.get(note.id)!);
        const updates = new Map<string, Partial<Note>>();

        notes.forEach((note) => {
            const rect = noteRects.get(note.id)!;
            const association = associations.get(note.id);
            if (!association) {
                const shouldRelayout =
                    duplicateIds.has(note.id) ||
                    (note.x === 0 && note.y === 0) ||
                    !Number.isFinite(note.x) ||
                    !Number.isFinite(note.y);
                const position = shouldRelayout
                    ? (findNotePosition({
                          base: orphanBase,
                          note: rect,
                          blockers: [...occupied, ...areaRects, ...tableRects],
                      }) ?? orphanBase)
                    : { x: rect.x, y: rect.y };
                if (shouldRelayout) occupied.push({ ...rect, ...position });
                const update: Partial<Note> = {
                    x: position.x,
                    y: position.y,
                    width: rect.width,
                    height: rect.height,
                    color: colorOptions.includes(note.color)
                        ? note.color
                        : defaultNoteColor,
                };
                if (
                    update.x !== note.x ||
                    update.y !== note.y ||
                    update.width !== note.width ||
                    update.height !== note.height ||
                    update.color !== note.color
                )
                    updates.set(note.id, update);
                return;
            }

            const { area, inside } = association;
            const areaTables = tables
                .filter((table) => table.parentAreaId === area.id)
                .map(getTableRect);
            const placementInside =
                inside &&
                area.width >= rect.width + 32 &&
                area.height >= rect.height + 56;
            const nextToBase = {
                x: area.x + area.width + NOTE_GAP,
                y: area.y,
            };
            const nextToBlockers = [
                ...occupied,
                ...tableRects,
                ...areas
                    .filter((candidate) => candidate.id !== area.id)
                    .map((candidate) => ({
                        x: candidate.x,
                        y: candidate.y,
                        width: candidate.width,
                        height: candidate.height,
                    })),
            ];
            const insideBase = { x: area.x + 16, y: area.y + 40 };
            const position =
                findNotePosition({
                    base: placementInside ? insideBase : nextToBase,
                    note: rect,
                    blockers: placementInside
                        ? [...occupied, ...areaTables]
                        : nextToBlockers,
                    area: placementInside ? area : undefined,
                }) ??
                (placementInside
                    ? findNotePosition({
                          base: nextToBase,
                          note: rect,
                          blockers: nextToBlockers,
                      })
                    : null) ??
                nextToBase;
            occupied.push({ ...rect, ...position });

            const update: Partial<Note> = {
                x: position.x,
                y: position.y,
                width: rect.width,
                height: rect.height,
                color: area.color,
            };
            if (
                update.x !== note.x ||
                update.y !== note.y ||
                update.width !== note.width ||
                update.height !== note.height ||
                update.color !== note.color
            ) {
                updates.set(note.id, update);
            }
        });

        await Promise.all(
            [...updates].map(([id, update]) => updateNote(id, update))
        );
    }, [areas, notes, readonly, tables, updateNote]);

    const showRepairConfirmation = useCallback(() => {
        if (readonly || notes.length === 0) return;
        showAlert({
            title: t('side_panel.notes_section.repair_title', {
                defaultValue: 'Fix note layout',
            }),
            description: t('side_panel.notes_section.repair_description', {
                defaultValue:
                    'Resize invalid legacy notes, remove overlaps, and match notes near an area to that area’s color.',
            }),
            actionLabel: t('side_panel.notes_section.repair_action', {
                defaultValue: 'Fix layout',
            }),
            closeLabel: t('common.cancel', { defaultValue: 'Cancel' }),
            onAction: repairNoteLayout,
        });
    }, [notes.length, readonly, repairNoteLayout, showAlert, t]);

    return (
        <div className="flex flex-1 flex-col overflow-hidden px-2">
            <div className="flex items-center justify-between gap-4 pb-1">
                <div className="flex-1">
                    <Input
                        ref={filterInputRef}
                        type="text"
                        placeholder={t('side_panel.notes_section.filter')}
                        className="h-8 w-full focus-visible:ring-0"
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                    />
                </div>
                {!readonly ? (
                    <div className="flex items-center gap-1">
                        <Button
                            variant="outline"
                            className="h-8 p-2 text-xs"
                            onClick={showRepairConfirmation}
                            disabled={notes.length === 0}
                            aria-label={t(
                                'side_panel.notes_section.repair_title',
                                { defaultValue: 'Fix note layout' }
                            )}
                            title={t('side_panel.notes_section.repair_title', {
                                defaultValue: 'Fix note layout',
                            })}
                        >
                            <Scan className="h-4" />
                        </Button>
                        <Button
                            variant="secondary"
                            className="h-8 p-2 text-xs"
                            onClick={handleCreateNote}
                        >
                            <StickyNote className="h-4" />
                            {t('side_panel.notes_section.add_note')}
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-1 flex-col overflow-hidden">
                <ScrollArea className="h-full">
                    {notes.length === 0 ? (
                        <EmptyState
                            title={t(
                                'side_panel.notes_section.empty_state.title'
                            )}
                            description={t(
                                'side_panel.notes_section.empty_state.description'
                            )}
                            className="mt-20"
                            secondaryAction={
                                !readonly
                                    ? {
                                          label: t(
                                              'side_panel.notes_section.add_note'
                                          ),
                                          onClick: handleCreateNote,
                                      }
                                    : undefined
                            }
                        />
                    ) : filterText && filteredNotes.length === 0 ? (
                        <div className="mt-10 flex flex-col items-center gap-2">
                            <div className="text-sm text-muted-foreground">
                                {t('side_panel.notes_section.no_results')}
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleClearFilter}
                                className="gap-1"
                            >
                                <X className="size-3.5" />
                                {t('side_panel.notes_section.clear')}
                            </Button>
                        </div>
                    ) : (
                        <NotesList notes={filteredNotes} />
                    )}
                </ScrollArea>
            </div>
        </div>
    );
};
