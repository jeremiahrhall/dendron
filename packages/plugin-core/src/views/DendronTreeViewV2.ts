import {
  DendronError,
  DNodeUtils,
  NotePropsDictV2,
  NotePropsV2,
  NoteUtilsV2,
} from "@dendronhq/common-all";
import _ from "lodash";
import path from "path";
import vscode, {
  ExtensionContext,
  TextEditor,
  ThemeIcon,
  TreeView,
  Uri,
  window,
} from "vscode";
import { DENDRON_COMMANDS, ICONS } from "../constants";
import { Logger } from "../logger";
import { HistoryEvent, HistoryService } from "../services/HistoryService";
import { DendronWorkspace } from "../workspace";

function createTreeNote(note: NotePropsV2) {
  const collapsibleState = _.isEmpty(note.children)
    ? vscode.TreeItemCollapsibleState.None
    : vscode.TreeItemCollapsibleState.Collapsed;
  const tn = new TreeNote({
    note,
    collapsibleState,
  });
  if (note.stub) {
    tn.iconPath = new ThemeIcon(ICONS.STUB);
  } else if (note.schema) {
    tn.iconPath = new ThemeIcon(ICONS.SCHEMA);
  }
  return tn;
}

export class TreeNote extends vscode.TreeItem {
  public id: string;
  public note: NotePropsV2;
  public uri: Uri;
  public children: string[] = [];
  public L: typeof Logger;

  constructor({
    note,
    collapsibleState,
  }: {
    note: NotePropsV2;
    collapsibleState: vscode.TreeItemCollapsibleState;
  }) {
    super(DNodeUtils.basename(note.fname, true), collapsibleState);
    this.note = note;
    this.id = this.note.id;
    this.tooltip = this.note.title;
    const mainVault = (DendronWorkspace.workspaceFolders() as vscode.WorkspaceFolder[])[0];
    this.uri = Uri.file(
      path.join(mainVault.uri.fsPath, this.note.fname + ".md")
    );
    this.command = {
      command: DENDRON_COMMANDS.GOTO_NOTE.key,
      title: "",
      arguments: [{ qs: this.note.fname, mode: "note" }],
    };
    this.L = DendronWorkspace.instance().L;
  }
}

export class EngineNoteProvider implements vscode.TreeDataProvider<string> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    string | undefined | void
  > = new vscode.EventEmitter<string | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<string | undefined | void> = this
    ._onDidChangeTreeData.event;
  public tree: { [key: string]: TreeNote } = {};
  public active: string | undefined;

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  sort(notes: TreeNote[]): TreeNote[] {
    return _.sortBy(notes, "label");
  }

  getTreeItem(id: string): vscode.TreeItem {
    return this.tree[id];
  }

  getChildren(id?: string): Thenable<string[]> {
    const ctx = "TreeView:getChildren";
    Logger.debug({ ctx, id });
    const client = DendronWorkspace.instance().getEngine();
    if (!client.notes["root"]) {
      vscode.window.showInformationMessage("No notes found");
      return Promise.resolve([]);
    }
    if (id) {
      return Promise.resolve(this.tree[id].children);
    } else {
      Logger.info({ ctx, msg: "reconstructing tree" });
      const root = client.notes["root"];
      Logger.debug({ ctx, notes: client.notes });
      return Promise.resolve(this.parseTree(root, client.notes).children);
    }
  }

  async getParent(id: string) {
    const client = DendronWorkspace.instance().getEngine();
    const maybeParent =
      client.notes[(this.tree[id] as TreeNote).note.parent || ""];
    return maybeParent ? maybeParent.id : null;
  }

  parseTree(note: NotePropsV2, ndict: NotePropsDictV2): TreeNote {
    const ctx = "TreeViewV2:parseTree";
    Logger.debug({ ctx, note, msg: "enter" });
    const tn = createTreeNote(note);
    this.tree[note.id] = tn;
    let children = note.children.map((c) => {
      const childNote = ndict[c];
      if (!childNote) {
        const err = { msg: `no childNote found: ${c}` };
        Logger.error({ err });
        throw new DendronError(err);
      }
      return this.parseTree(childNote, ndict);
    });
    tn.children = this.sort(children).map((c) => c.id);
    Logger.debug({ ctx, note, msg: "exit" });
    return tn;
  }
}

export class DendronTreeViewV2 {
  static register(_context: ExtensionContext) {
    HistoryService.instance().subscribe(
      "extension",
      async (_event: HistoryEvent) => {
        if (_event.action === "initialized") {
          const ws = DendronWorkspace.instance();
          const treeDataProvider = new EngineNoteProvider();
          await treeDataProvider.getChildren();
          const treeView = window.createTreeView("dendronTreeView", {
            treeDataProvider,
            showCollapseAll: true,
          });
          const _class = new DendronTreeViewV2(treeView, treeDataProvider);
          ws.dendronTreeView = _class;
        }
      }
    );
  }

  constructor(
    public treeView: TreeView<string>,
    public treeProvider: EngineNoteProvider
  ) {
    DendronWorkspace.instance().addDisposable(
      window.onDidChangeActiveTextEditor(this.onOpenTextDocument, this)
    );
  }

  async onOpenTextDocument(editor: TextEditor | undefined) {
    if (_.isUndefined(editor)) {
      return;
    }
    if (!this.treeView.visible) {
      return;
    }
    const uri = editor.document.uri;
    const basename = path.basename(uri.fsPath);
    if (basename.endsWith(".md")) {
      const fname = DNodeUtils.uri2Fname(uri);
      const notes = DendronWorkspace.instance().getEngine().notes;
      const note = NoteUtilsV2.getNoteByFname(fname, notes);
      if (note) {
        this.treeView.reveal(note.id);
      }
    }
  }
}
