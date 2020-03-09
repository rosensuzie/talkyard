/*
 * Copyright (c) 2015-2018 Kaj Magnus Lindberg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/// <reference path="../editor-prelude.editor.ts" />

//------------------------------------------------------------------------------
   namespace debiki2.editor {
//------------------------------------------------------------------------------

const d = { i: debiki.internal };
const r = ReactDOMFactories;
let FileAPI;

let theEditor: any;

export const ReactTextareaAutocomplete = reactCreateFactory(window['ReactTextareaAutocomplete']);


export function getOrCreateEditor(success) {
  if (theEditor) {
    success(theEditor);
  }
  else {
    // These might not be available until now, because scripts loaded in parallel (order = undefined).
    FileAPI = window['FileAPI'];
    theEditor = ReactDOM.render(Editor({}), utils.makeMountNode());
    success(theEditor);
  }
}


export const listUsernamesTrigger = {
  '@': {
    dataProvider: token =>
      new Promise(function (resolve, reject) {
        const pageId = ReactStore.getPageId();
        if (!pageId || pageId === EmptyPageId) {
          // This is an embedded comments discussion, but there are no comments, so the
          // discussion has not yet been lazy-created. So search among users, for now.
          // UX maybe one *always* wants to search among all users? Unless if is chat channel?
          Server.listAllUsernames(token, resolve);
        }
        else {
          // One probably wants to mention someone participating in the current discussion = page?
          // So search among those users only.
          Server.listUsernames(token, pageId, resolve);
        }
      }),
    component: ({ entity: { id, username, fullName }}) =>
      r.div({}, `${username} (${fullName})`),
    output: (item, trigger) => '@' + item.username
  }
};


interface EditorState {
  store: Store;
  embMainStoreCopy?: Partial<Store>;
  visible: boolean;
  replyToPostNrs: PostNr[];
  anyPostType?: PostType;
  editorsCategories?: Category[];
  editorsPageId?: PageId;
  editingPostNr?: PostNr;
  editingPostUid?: PostId;  // CLEAN_UP RENAME to ...PostId not ...Uid
  isWritingChatMessage?: boolean;
  messageToUserIds: UserId[],
  newForumTopicCategoryId?: CategoryId;
  newPageRole?: PageType;
  editingPostRevisionNr?: number;
  text: string;
  title: string;
  showTitleErrors?: boolean;
  showTextErrors?: boolean;
  draftStatus: DraftStatus;
  draft?: Draft;
  draftErrorStatusCode?: number;
  safePreviewHtml: string;
  onDone?:  EditsDoneHandler;
  guidelines?: Guidelines;
  showGuidelinesInModal?: boolean;
  backdropOpacity: 0,
  isUploadingFile: boolean;
  fileUploadProgress: number;
  uploadFileXhr?: any;
  showSimilarTopics?: boolean;
  searchResults?: any;

  showMinimized?: boolean;
  showOnlyPreview?: boolean;
  showMaximized?: boolean;
  splitHorizontally?: boolean;
}

interface Guidelines {
  writingWhat: WritingWhat,
  categoryId: CategoryId;
  pageRole: PageType;
  safeHtml: string;
  hidden: boolean;
}


export const Editor = createFactory<any, EditorState>({
  displayName: 'Editor',
  mixins: [debiki2.StoreListenerMixin],

  getInitialState: function(): EditorState {
    return {
      store: debiki2.ReactStore.allData(),
      visible: false,
      text: '',
      title: '',
      draftStatus: DraftStatus.NotLoaded,
      safePreviewHtml: '',
      replyToPostNrs: [],
      messageToUserIds: [],
      backdropOpacity: 0,
      isUploadingFile: false,
      fileUploadProgress: 0,
      uploadFileXhr: null,
    };
  },

  onChange: function() {
    this.setState({ store: debiki2.ReactStore.allData() });
  },

  componentWillMount: function() {
    this.updatePreviewSoon = _.debounce(this.updatePreviewNow, 333);

    this.saveDraftSoon = _.debounce(() => {
      if (this.isGone || !this.state.visible) return;
      this.saveDraftNow();  // [7AKBJ42]
    }, 2022);

    this.searchForSimilarTopicsSoon = _.debounce(this.searchForSimilarTopicsNow, 1800);
  },

  componentDidMount: function() {
    // Minor BUG: resizing .dw-comments to adjust for the textarea doesn't work. (5YKQ27)
    this.columns = $all('#esPageColumn, #esWatchbarColumn, #dw-sidebar .dw-comments');
    this.makeEditorResizable();
    this.initUploadFileStuff();
    this.perhapsShowGuidelineModal();
    window.addEventListener('unload', this.saveDraftUseBeacon);
    // Don't scroll the main discussion area, when scrolling inside the editor.
    /* Oops this breaks scrolling in the editor and preview.
    $(this.refs.editor).on('scroll touchmove mousewheel', function(event) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }); */
  },

  componentDidUpdate: function(prevProps, prevState) {
    this.perhapsShowGuidelineModal();
    if (!prevState.visible && this.state.visible) {
      this.makeSpaceAtBottomForEditor();
    }
    if (talkyard.postElemPostProcessor && prevState.safePreviewHtml !== this.state.safePreviewHtml) {
      talkyard.postElemPostProcessor('t_E_Preview');
    }
  },

  componentWillUnmount: function() {
    this.isGone = true;
    console.debug("Editor: componentWillUnmount");
    window.removeEventListener('unload', this.saveDraftUseBeacon);
    this.saveDraftNow();
  },

  focusInputFields: function() {
    let elemToFocus = findDOMNode(this.refs.titleInput);
    if (!elemToFocus && this.refs.rtaTextarea) {
      elemToFocus = findDOMNode(this.refs.rtaTextarea.textareaRef);
    }
    if (elemToFocus) {
      elemToFocus.focus();
    }
  },

  makeEditorResizable: function() {
    if (eds.isInEmbeddedEditor) {
      // The iframe is resizable instead. [RESEMBEDTR]
      return;
    }
    util.makeResizableUp(this.refs.editor, this.refs.resizeHandle, this.makeSpaceAtBottomForEditor);
  },

  makeSpaceAtBottomForEditor: function() {
    if (this.isGone) return;
    const editorHeightPx = this.refs.editor.clientHeight + 'px';
    _.each(this.columns, (c) => {
      c.style.bottom = editorHeightPx; // has no effect for the sidebar (5YKQ27)
    });
  },

  returnSpaceAtBottomForEditor: function() {
    _.each(this.columns, (c) => {
      c.style.bottom = '0px';
    });
  },

  selectAndUploadFile: function() {
    this.refs.uploadFileInput.click();
  },

  // We never un-initialize this, instead we reuse the same editor instance always once created.
  initUploadFileStuff: function() {
    if (!this.refs.uploadFileInput)
      return;

    // Some browsers open a dropped file in the current browser tab, if one misses the
    // drop target with a few pixels. Prevent that. See: http://stackoverflow.com/questions/9544977/using-jquery-on-for-drop-events-when-uploading-files-from-the-desktop#comment20423424_9545050
    document.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
    });

    FileAPI.event.on(document, 'drop', (event: Event) => {
      event.preventDefault();
      if (this.isGone || !this.state.visible) return;
      FileAPI.getDropFiles(event, (files: File[]) => {
        if (files.length > 1) {
          // This'll log a warning server side, I think I want that (want to know how
          // often this happens)
          die(t.e.UploadMaxOneFile + " [TyM5JYW2]");
        }
        this.uploadFiles(files);
      });
    });

    const inputElem = this.refs.uploadFileInput;
    FileAPI.event.on(inputElem, 'change', (event) => {
      const files = FileAPI.getFiles(event);
      this.uploadFiles(files);
    });
  },

  uploadFiles: function(files: File[]) {
    if (!files.length)
      return;

    dieIf(files.length != 1, 'EsE5GPY82');
    FileAPI.upload({   // a bit dupl code [2UK503]
      url: '/-/upload-public-file',
      headers: { 'X-XSRF-TOKEN': getSetCookie('XSRF-TOKEN') },
      files: { file: files },
      // This is per file.
      fileprogress: (event, file, xhr, options) => {
        if (this.isGone) return;
        if (!this.state.isUploadingFile) {
          this.setState({ isUploadingFile: true });
          pagedialogs.getProgressBarDialog().open(t.UploadingDots, () => {
            xhr.abort("Intentionally cancelled [EsM3GU05]");
            if (this.isGone) return;
            this.setState({ uploadCancelled: true });
          });
        }
        else {
          const percent = event.loaded / event.total * 100;
          pagedialogs.getProgressBarDialog().setDonePercent(percent);
        }
      },
      // This is when all files have been uploaded — but we're uploading just one.
      complete: (error, xhr) => {
        pagedialogs.getProgressBarDialog().close();
        if (!this.isGone) this.setState({
          isUploadingFile: false,
          uploadCancelled: false
        });
        if (error) {
          if (!this.state.uploadCancelled) {
            pagedialogs.getServerErrorDialog().open(xhr);
          }
          return;
        }
        if (this.isGone) return;
        const fileUrlPath = JSON.parse(xhr.response);
        dieIf(!_.isString(fileUrlPath), 'DwE06MF22');
        dieIf(!_.isString(this.state.text), 'EsE5FYZ2');
        const file = xhr.files[0];
        const linkHtml = this.makeUploadLink(file, fileUrlPath);
        const perhapsNewline = this.state.text.endsWith('\n') ? '' : '\n';
        this.setState({
          text: this.state.text + perhapsNewline + '\n' +
            // (There's a sanitizer for this — for everything in the editor.)
            "<!-- Uploaded file name:  " + file.name + "  -->\n" +
            linkHtml,
          draftStatus: DraftStatus.ShouldSave,
        }, () => {
          this.saveDraftSoon();
          // Scroll down so people will see the new line we just appended.
          scrollToBottom(this.refs.rtaTextarea.textareaRef);
          this.updatePreviewSoon();
          // This happens to early — maybe a onebox can take long to load?
          // Or the preview takes a while to update. — So wait for a while.
          setTimeout(() => {
            if (this.isGone) return;
            // Maybe no preview because of UI prefs.
            if (this.refs.preview) {
              scrollToBottom(this.refs.preview);
            }
          }, 900);
        });
      },
    });
  },

  cancelUpload: function() {
    if (this.state.uploadFileXhr) {
      this.state.uploadFileXhr.abort();
    }
    else {
      console.warn("Cannot cancel upload: No this.state.uploadFileXhr [DwE8UMW2]");
    }
  },

  showUploadProgress: function(percent) {
    if (percent === 0) {
      pagedialogs.getProgressBarDialog().open(t.UploadingDots, this.cancelUpload);
    }
    else {
      pagedialogs.getProgressBarDialog().setDonePercent(percent);
    }
    this.setState({
      isUploadingFile: true,
      fileUploadProgress: percent,
    });
  },

  hideUploadProgress: function() {
    pagedialogs.getProgressBarDialog().close();
    this.setState({
      uploadFileXhr: null,
      isUploadingFile: false,
      fileUploadProgress: 0,
    });
  },

  makeUploadLink: function(file, url) {
    // The relative path is like '/-/uploads/public/a/b/c...zwq.suffix' = safe,
    // and we got it from the server.
    dieIf(!url.match(/^[0-9a-z/\.-]+$/),
        "Bad image relative path: " + url + " [DwE8PUMW2]");

    const parts = url.split('.');
    const suffix = parts.length > 1 ? _.last(parts) : '';

    // (SVG doesn't work in old browsers, fine. tif doesn't work for me.)
    const isImage = suffix === 'png' || suffix === 'jpg' || suffix === 'jpeg' || suffix === 'gif' ||
        suffix === 'mpo' || suffix === 'bmp' || suffix === 'svg';

    // Only .mp4 is supported by all browsers.
    const isVideo = suffix === 'mp4' || suffix === 'ogg' || suffix === 'webm';

    let link;
    if (isImage) {
      // <img> is a void element, shouldn't be any </img> close tag.
      link = `<img src="${url}">`;
    }
    else if (isVideo) {
      link = '<video width="490" height="400" controls src="' + url + '"></video>';
    }
    else {
      // Unfortunately, download="the-file-name" won't work if a cdn is in use: needs to be same origin.
      // Can maybe add some http origin header?
      link = `<a download="${file.name}" href="${url}">${file.name}</a> (${prettyBytes(file.size)})`;
    }
    return link;
  },

  toggleWriteReplyToPostNr: function(postNr: PostNr, inclInReply: boolean,
        anyPostType?: PostType) {
    if (this.alertBadState('WriteReply'))
      return;

    const store: Store = this.state.store;
    let postNrs = this.state.replyToPostNrs;

    if (inclInReply && postNrs.length) {
      // This means we've started replying to a post, and then clicked Reply
      // for *another* post too — i.e. we're trying to reply to more than one post,
      // a a single time. This is, in Talkyard, called Multireply.
      // Disable this for now — it's disabled server side, and the UX for this was
      // poor actually.
      // Disable the reply buttons? Also see (5445522) just below. — Done,
      // see store.isEditorOpen.
      // @ifdef DEBUG
      die('TyE305FKUGPGJ0');
      // @endif
      return;
    }

    // No multireplies — disabled.
    dieIf(postNrs.length >= 2, 'TyE35KKGJRT0');

    if (this.state.editorsPageId !== store.currentPageId && postNrs.length) {
      // The post nrs on this different page, won't match the ones in postNrs.
      // So ignore this.
      // UX COULD disable the reply buttons? Also see (5445522) just above.  — Done.
      // @ifdef DEBUG
      die('TyE630KRGUJMF');
      // @endif
      return;
    }

    // Insert postNr into the list of posts we're replying to — or remove it, if present. (I.e. toggle.)

    const index = postNrs.indexOf(postNr);
    if (inclInReply && index >= 0) {
      // 2020: Dead code.
      die('TyE305WKGJS34');
      /*
      // Now almost certainly this can be removed — Reply buttons hidden,
      // once edior open. So cannot get out of sync?
      // Editor out of sync with reply button states: reply button wants to add,
      // editor wants to remove the post, from the reply-to-list.
      // Happened in embedded comments iframe because of a bug. Fixed now, but keep this
      // anyway, in case there're other such iframe + iframe sync bugs?
      // @ifdef DEBUG
      console.warn("Discussion button and editor reply-list out of sync: " +
          "inclInReply && index >= 0  [TyE5UKJWVDQ2]");
      debugger;
      // @endif
      postNrs = [postNr];
      this.showEditor();
      */
    }
    else if (index === -1) {
      // We're starting to write a reply to postNr.
      postNrs.push(postNr);
    }
    else {
      // 2020: Dead code.
      die('TyE305WKGJS34');
      // Remove postNr — we're not going to reply to it any longer.
      //postNrs.splice(index, 1);
    }

    // Don't change post type from flat to something else.
    let postType = anyPostType;
    if (postNrs.length >= 2 && this.state.anyPostType === PostType.Flat) {
      postType = PostType.Flat;
    }

    // If we're in the blog comments editor iframe, then, usernames are avaiable
    // only in the "main" iframe — the one with all comments. Let's clone
    // the parts we need, and store in our own local React store.
    //
    // COULD ask about this approach (i.e. using data from another iframe
    // on the same domain) at StackOverflow, but for now, just try-catch
    // — if won't work, some old ode that shows:
    //   "Replying to post-1234" text:
    // will run instead — all fine.
    //
    const mainStore: Store = getMainWinStore();
    let embMainStoreCopy: Partial<Store> | undefined;
    if (eds.isInEmbeddedEditor) {
      try {
        embMainStoreCopy = {
          // Clone data from the other iframe, so as not to 1) hold on to it
          // and thereby maybe preventing data in that other frame from being
          // freed. Probably not needed, since this arene't html tags, just
          // variables, but let's clone anyway just in case.
          // And 2) not getting it changed "at any time" by the other iframe
          // — React.js wouldn't llike that.
          currentPage: _.cloneDeep(mainStore.currentPage),
          usersByIdBrief: _.cloneDeep(mainStore.usersByIdBrief),
          currentPageId: mainStore.currentPageId,
        };
      }
      catch (ex) {
        // Oh well.
        if (!this.loggedCloneError) {
          console.warn("Couldn't clone Partial<Store> from main iframe [TyECLONSTOR]", ex);
          // @ifdef DEBUG
          debugger;
          // @endif
          this.loggedCloneError = true;
        }
      }
    }

    const newState: Partial<EditorState> = {
      embMainStoreCopy,
      anyPostType: postType,
      editorsCategories: store.currentCategories,
      editorsPageId: store.currentPageId || eds.embeddedPageId,
      replyToPostNrs: postNrs,
      text: this.state.text || makeDefaultReplyText(store, postNrs),
    };
    this.showEditor(newState);

    if (!postNrs.length) {
      this.saveDraftClearAndClose();
      return;
    }

    const draftType = postType === PostType.BottomComment ?
        DraftType.ProgressPost : DraftType.Reply;

    const draftLocator: DraftLocator = {
      draftType,
      pageId: newState.editorsPageId,
      postNr: postNrs[0], // for now
    };
    draftLocator.postId = store_getPostId(mainStore, draftLocator.pageId, draftLocator.postNr);
    if (eds.embeddingUrl) {
      draftLocator.embeddingUrl = eds.embeddingUrl;
    }

    let writingWhat = WritingWhat.ReplyToNotOriginalPost;
    if (_.isEqual([BodyNr], postNrs)) writingWhat = WritingWhat.ReplyToOriginalPost;
    else if (_.isEqual([NoPostId], postNrs)) writingWhat = WritingWhat.ChatComment;

    this.loadDraftAndGuidelines(draftLocator, writingWhat);
  },

  editPost: function(postNr: PostNr, onDone?: EditsDoneHandler) {
    // [editor-drafts] UX COULD somehow give the user the option to cancel & close, without
    // loading? saving? any draft.

    if (this.alertBadState())
      return;
    Server.loadDraftAndText(postNr, (response: LoadDraftAndTextResponse) => {
      const state: EditorState = this.state;
      if (this.isGone) return;
      const store: Store = state.store;
      const draft: Draft | undefined = response.draft;

      // In case the draft was created when one wasn't logged in, then, now, set a user id.
      if (draft && store.me) {
        draft.byUserId = store.me.id;
      }

      // This can fail, if the post was moved by staff to a different page? Then it
      // gets a new postNr. Then do what? Show a "this post was moved to: ..." dialog?
      dieIf(postNr !== response.postNr, 'TyE23GPKG4');

      const newState: Partial<EditorState> = {
        anyPostType: null,
        editorsCategories: store.currentCategories,
        editorsPageId: response.pageId,
        editingPostNr: postNr,
        editingPostUid: response.postUid,
        editingPostRevisionNr: response.currentRevisionNr,
        text: draft ? draft.text : response.currentText,
        onDone: onDone,
        draftStatus: DraftStatus.NothingHappened,
        draft,
      };

      this.showEditor(newState);
    });
  },

  editNewForumPage: function(categoryId: number, role: PageRole) {
    if (this.alertBadState())
      return;
    const state: EditorState = this.state;
    // Private chat topics shouldn't be placed in any category.
    dieIf(role === PageRole.PrivateChat && categoryId, 'EsE5KF024');
    // But other topics should be placed in a category.
    dieIf(role !== PageRole.PrivateChat && !categoryId, 'EsE8PE2B');

    const text = state.text || '';
    const store: Store = state.store;

    const newState: Partial<EditorState> = {
      anyPostType: null,
      editorsCategories: store.currentCategories,
      editorsPageId: store.currentPageId,
      newForumTopicCategoryId: categoryId,
      newPageRole: role,
      text: text,
      showSimilarTopics: true,
      searchResults: null,
    };

    this.showEditor(newState);

    const draftLocator: DraftLocator = {
      draftType: DraftType.Topic,
      pageId: store.currentPageId,
      categoryId: categoryId,
    };

    this.loadDraftAndGuidelines(draftLocator, WritingWhat.NewPage, role);
  },

  openToEditChatTitleAndPurpose: function() {   // RENAME to  openToEditChatPurpose only (not title)
    this.editPost(BodyNr);
  },

  openToWriteChatMessage: function(text: string, draft: Draft | undefined, draftStatus,
        onDone?: EditsDoneHandler) {
    if (this.alertBadState())
      return;

    const store: Store = this.state.store;
    const newState: Partial<EditorState> = {
      editorsCategories: store.currentCategories,
      editorsPageId: store.currentPageId,
      isWritingChatMessage: true,
      text: text || '',
      draft,
      draftStatus,
      onDone,
    };

    this.showEditor(newState);
    // No guidelines for chat messages, because usually a smaller "inline" editor is used instead.
  },

  openToWriteMessage: function(userId: UserId) {
    if (this.alertBadState())
      return;
    const store: Store = this.state.store;
    const newState: Partial<EditorState> = {
      editorsCategories: store.currentCategories,
      editorsPageId: store.currentPageId,
      messageToUserIds: [userId],
      text: '',
      newPageRole: PageRole.FormalMessage,
    };
    
    this.showEditor(newState);

    const draftLocator: DraftLocator = {
      draftType: DraftType.DirectMessage,
      toUserId: userId,
    };
    this.loadDraftAndGuidelines(draftLocator, WritingWhat.NewPage, PageRole.FormalMessage);
    this.showAndFadeOutBackdrop();
  },

  showAndFadeOutBackdrop: function() {
    // Later: Start using util.FadingBackdrop instead. [4KEF0YUU2]
    this.setState({ backdropOpacity: 0.83 });
    const fadeBackdrop = () => {
      const state: EditorState = this.state;
      if (this.isGone || !state.visible) return;
      const opacity = state.backdropOpacity;
      const nextOpacity = opacity < 0.01 ? 0 : opacity - 0.009;
      this.setState({ backdropOpacity: nextOpacity });
      if (nextOpacity) {
        setTimeout(fadeBackdrop, 16);
      }
    };
    setTimeout(fadeBackdrop, 1400);
  },

  alertBadState: function(wantsToDoWhat = null): boolean {
    // REFACTOR  we call clearIsReplyingMarks from here, so cannot return directly if allFine,
    // which makse this unnecessarily complicated?
    // :- ) But now clearIsReplyingMarks() is gone !
    // so can simplify? this.  (it was old jQuery code that highlighted
    // the active Reply button(s).)

    const state: EditorState = this.state;
    const store: Store = state.store;
    const allFine = state.draftStatus <= DraftStatus.NeedNotSave &&
        store.currentPageId === state.editorsPageId;
    const maybeAlert = allFine ? (x: any) => {} : alert;
    let seemsBad = false;

    if (wantsToDoWhat !== 'WriteReply' && state.replyToPostNrs.length > 0) {
      maybeAlert(t.e.PleaseFinishPost);
      seemsBad = true;
    }

    if (state.isWritingChatMessage) {
      maybeAlert(t.e.PleaseFinishChatMsg);
      seemsBad = true;
    }

    if (state.messageToUserIds.length) {
      maybeAlert(t.e.PleaseFinishMsg);
      seemsBad = true;
    }

    if (_.isNumber(state.editingPostNr)) {
      maybeAlert(t.e.PleaseSaveEdits);
      seemsBad = true;
    }

    if (state.newPageRole) {
      maybeAlert(t.e.PleaseSaveOrCancel);
      seemsBad = true;
    }

    return !allFine && seemsBad;
  },

  loadDraftAndGuidelines: function(draftLocator: DraftLocator, writingWhat: WritingWhat,
        pageRole?: PageRole) {

    const setDraftAndGuidelines = (anyDraft?, anyGuidelines?) => {
      const draft = anyDraft || BrowserStorage.get(draftLocator);
      console.debug("Setting draft and guidelines: !!anyDraft: " + !!anyDraft +
          " !!draft: " + !!draft +
          " !!anyGuidelines: " + !!anyGuidelines);
      const newState: Partial<EditorState> = {
        draft,
        draftStatus: DraftStatus.NothingHappened,
        text: draft ? draft.text : '',
        title: draft ? draft.title : '',
        // For now, skip guidelines, for blog comments — they would break e2e tests,
        // and maybe are annoying?
        guidelines: eds.isInIframe ? undefined : anyGuidelines,
      };
      this.setState(newState, () => {
        this.focusInputFields();
        this.scrollToPreview = true;
        this.updatePreviewSoon();
      });
    };

    const state: EditorState = this.state;
    if (isEmbeddedNotYetCreatedPage(state)) {
      // Cannot currently load draft & guidelines (below) for a not-yet-created page.
      // Instead, we'll load from the browser. [BLGCMNT1]
      setDraftAndGuidelines();
      return;
    }

    const store: Store = getMainWinStore();

    // For embedded comments iframes, the page might not yet have been created,
    // and the categoryId might be unknown / undefined.
    const page: Page = store.currentPage;
    const categoryId: CategoryId | undefined = draftLocator.categoryId || page.categoryId;
    const pageType: PageRole = pageRole || page.pageRole || (
      eds.isInEmbeddedEditor ? PageRole.EmbeddedComments : die('TyE305WKD'));

    // What's this? why? I should have added a comment. The code seems to say that
    // if *guidelines* have been loaded, then any *draft* has also been loaded.
    const currentGuidelines = state.guidelines;
    if (currentGuidelines &&
        currentGuidelines.categoryId === categoryId &&
        currentGuidelines.pageRole === pageType &&
        currentGuidelines.writingWhat === writingWhat) {
      this.setState({ draftStatus: DraftStatus.NothingHappened });
      return;
    }

    console.debug("Loading draft and guidelines...");
    Server.loadDraftAndGuidelines(draftLocator, writingWhat, categoryId, pageType,
        (guidelinesSafeHtml: string | U, draft?: Draft) => {
      console.debug("Done loading draft and guidelines.");
      const state: EditorState = this.state;
      if (this.isGone || !state.visible)
        return;
      let guidelines = undefined;
      if (guidelinesSafeHtml) {
        const guidelinesHash = hashStringToNumber(guidelinesSafeHtml);
        const hiddenGuidelinesHashes = BrowserStorage.get('dwHiddenGuidelinesHashes') || {};
        const isHidden = hiddenGuidelinesHashes[guidelinesHash];
        guidelines = {
          writingWhat: writingWhat,
          categoryId: categoryId,
          pageRole: pageType,
          safeHtml: guidelinesSafeHtml,
          hidden: isHidden,
        };
      }
      setDraftAndGuidelines(draft, guidelines);
    });
  },

  // Remembers that these guidelines have been hidden, by storing a hash of the text in localStorage.
  // So, if the guidelines get changed, they'll be shown again (good). COULD delete old hashes if
  // we end up storing > 100? hashes?
  hideGuidelines: function() {
    const state: EditorState = this.state;
    const guidelines = state.guidelines;
    guidelines.hidden = true;
    this.setState({
      guidelines: guidelines,
      showGuidelinesInModal: false,
    });
    const hash = hashStringToNumber(guidelines.safeHtml);
    const hiddenGuidelinesHashes = BrowserStorage.get('dwHiddenGuidelinesHashes') || {};
    hiddenGuidelinesHashes[hash] = true;
    BrowserStorage.set('dwHiddenGuidelinesHashes', hiddenGuidelinesHashes);
  },

  showGuidelines: function() {
    const state: EditorState = this.state;
    const guidelines = state.guidelines;
    guidelines.hidden = false;
    this.setState({ guidelines: guidelines });
    // Leave hidden on page reload? I.e. don't update the browser storage.
  },

  // If we're showing some guidelines, but they're not visible on screen, then show them
  // in a modal dialog instead — guidelines are supposedly fairly important.
  perhapsShowGuidelineModal: function() {
    const state: EditorState = this.state;
    if (!this.refs.guidelines || state.showGuidelinesInModal)
      return;

    // If the guidelines are visible, we don't need no modal.
    const rect = this.refs.guidelines.getBoundingClientRect();
    if (rect.top >= 0)
      return;

    this.setState({ showGuidelinesInModal: true });
  },

  onTitleEdited: function(event) {
    const title = event.target.value;
    this._handleEditsImpl(title, this.state.text);
  },

  isTitleOk: function() {
    // For now
    const state: EditorState = this.state;
    const title = state.title ? state.title.trim() : null;
    if (!title) return false;
    return true;
  },

  onTextEdited: function(event) {
    const text = event.target.value;
    this._handleEditsImpl(this.state.title, text);
  },

  _handleEditsImpl: function(title: string | undefined, text: string | undefined) {
    const state: EditorState = this.state;

    // A bit dupl code [7WKABF2]
    const draft: Draft = state.draft;
    const draftStatus = draft && draft.text === text && draft.title === title
        ? DraftStatus.EditsUndone
        : DraftStatus.ShouldSave;

    const titleChanged = state.title !== title;

    this.setState({ title, text, draftStatus }, () => {
      if (draftStatus === DraftStatus.ShouldSave) {
        this.saveDraftSoon();
      }
      if (titleChanged) {
        this.searchForSimilarTopicsSoon();
      }
      this.updatePreviewSoon();
    });
  },

  onKeyPressOrKeyDown: function(event) {
    // In my Chrome, Ctrl + Enter won't fire onKeyPress, only onKeyDown. [5KU8W2]
    if (event_isCtrlEnter(event)) {
      event.preventDefault();
      this.saveStuff();
    }
    if (event_isEscape(event)) {
      this.saveDraftClearAndClose();
    }
  },

  isTextOk: function() {
    // For now
    const state: EditorState = this.state;
    const text = state.text ? state.text.trim() : null;
    if (!text) return false;
    return true;
  },

  updatePreviewNow: function() {
    // This function is debounce-d, so the editor might have been cleared
    // and closed already, or even unmounted.
    const state: EditorState = this.state;
    if (this.isGone || !state.visible)
      return;

    // This cannot be a function param, because updatePreviewSoon() is debounce():d,
    // and only args from the last invokation are sent — so any scrollToPreview = true
    // argument, could get "debounce-overwritten".
    const scrollToPreview = this.scrollToPreview;
    delete this.scrollToPreview;

    // (COULD verify still edits same post/thing, or not needed?)
    const isEditingBody = state.editingPostNr === BodyNr;
    const sanitizerOpts = {
      allowClassAndIdAttr: true, // or only if isEditingBody?  dupl [304KPGSD25]
      allowDataAttr: isEditingBody
    };

    const safeHtml = markdownToSafeHtml(
        state.text, window.location.host, sanitizerOpts);

    this.setState({
      // UX COULD save this in the draft too, & send to the server, so the preview html
      // is available when rendering the page and one might want to see one's drafts,
      // here: [DRAFTPRVW]. But would need to sanitize server side (!).
      safePreviewHtml: safeHtml,
    }, () => {
      // Show an in-page preview, unless we're creating a new page.
      const state: EditorState = this.state;
      if (!state.newPageRole) {
        const params: ShowEditsPreviewParams = {
          scrollToPreview,
          safeHtml,
          editorsPageId: state.editorsPageId,
        };
        const postNrs: PostNr[] = state.replyToPostNrs;
        if (postNrs.length === 1) {
          params.replyToNr = postNrs[0];
          params.anyPostType = state.anyPostType;
        }
        if (state.editingPostUid) {
          params.editingPostNr = state.editingPostNr;
        }
        ReactActions.showEditsPreview(params);
        // We'll hide the preview, wheh closing the editor, here: (TGLPRVW)
      }
    });
  },

  searchForSimilarTopicsNow: function() {
    if (!this.refs.editor)
      return;

    const store: Store = this.state.store;
    const state: EditorState = this.state;
    let settings: SettingsVisibleClientSide = store.settings;
    if (settings.enableSimilarTopics === false)
      return;

    // Wait until has typed a bit, so there's sth to search for.
    // People sometimes type short titles like "Popups flicker" or "gravatar support",
    // so start searching fairly soon:
    const trimmedTitle = (state.title || '').trim();
    const tooFewChars = trimmedTitle.length < 12;
    const tooFewWords = trimmedTitle.indexOf(' ') === -1;  // 2 words

    let skipSilimarTopics = tooFewChars || tooFewWords;

    // For now, if not enough space to show a list of similar topics, don't do it.
    // UX COULD instead show the similar topics, between the title input, and the
    // topic body textarea input. (StackOverflow does this, for some screen resolutons).
    // This'd work on mobile, at least if it's in portrait orientation
    // (in landscape orientation, might push the textarea down below the lower edge
    // of the screen — maybe bad?).
    if (!skipSilimarTopics) {
      const rect = this.refs.editor.getBoundingClientRect();
      skipSilimarTopics = rect.top < 170; // sync w css [SIMLTPCH]
    }

    if (skipSilimarTopics) {
      if (state.searchResults) {
        this.setState({ searchResults: null });
      }
      return;
    }

    Server.search(state.title, (searchResults: SearchResults) => {
      const state: EditorState = this.state;
      if (this.isGone || !state.visible)
        return;
      // Exclude category description pages — they're off-topic, here. Also don't show
      // forum topic index pages or blog post list pages. (Such pages are typically
      // *not* answers to a question we're asking.)
      const pagesNoAboutCats = _.filter(
          searchResults.pagesAndHits, (ph: PageAndHits) =>
              ph.pageType !== PageRole.About && !isSection(ph.pageType));
      searchResults = { ...searchResults, pagesAndHits: pagesNoAboutCats };
      this.setState({ searchResults });
    }, null, { showLoadingOverlay: false });
  },

  changeCategory: function(categoryId: CategoryId) {
    this.setState({ newForumTopicCategoryId: categoryId });
  },

  changeNewForumPageRole: function(pageRole: PageRole) {
    this.setState({ newPageRole: pageRole });
  },

  onCancelClick: function() {
    const state: EditorState = this.state;
    this.callOnDoneCallback(false);
    if (state.isWritingChatMessage) {
      // We'll continue editing in the simple inline editor, and it'll save the draft —
      // don't save here too; that could result in dupl drafts [TyT270424]. Also, no
      // can-continue-editing tips needed, because we're just switching to the simple inline editor.
      this.clearAndClose();
    }
    else {
      this.saveDraftClearAndClose();
    }
  },

  makeEmptyDraft: function(): Draft | undefined {
    const state: EditorState = this.state;
    const anyPostType: PostType | undefined = state.anyPostType;
    const locator: DraftLocator = { draftType: DraftType.Scratch };
    const mainStore: Store = eds.isInEmbeddedEditor ? getMainWinStore() : state.store;

    // If we're in an iframe, the page might have gotten lazy-created; then
    // we need to use eds.embeddedPageId.
    const editorsPageId = state.editorsPageId || eds.embeddedPageId;

    let postType: PostType;

    // @ifdef DEBUG
    dieIf(!state.replyToPostNrs, '[TyE502KRDL35]');
    const pageExists = !!state.editorsPageId;
    // Cannot *edit* sth, if page doesn't exist.
    dieIf(!pageExists && state.editingPostNr, '[TyE40JMABN42]');
    // Cannot create forum topics, if the forum page itself doesn't exist.
    dieIf(!pageExists && state.newForumTopicCategoryId, '[TyE40JMABN43]');
    // Cannot post chat messages on non-existing pages.
    dieIf(!pageExists && state.isWritingChatMessage, '[TyE40JMABN44]');
    // But yes — can post new replies, if the page doesn't exist,
    // because PageRole.EmbeddedComments pages get created lazily.
    // @endif

    if (state.editingPostNr) {
      locator.draftType = DraftType.Edit;
      locator.pageId = editorsPageId;
      locator.postId = state.editingPostUid;
      locator.postNr = state.editingPostNr;
    }
    else if (state.replyToPostNrs?.length) {  // can remove '?.', never undef? [TyE502KRDL35]
      // @ifdef DEBUG
      dieIf(anyPostType !== PostType.Normal &&
          anyPostType !== PostType.BottomComment, 'TyE25KSTJ30');
      // @endif
      postType = anyPostType || PostType.Normal;
      locator.draftType = postType_toDraftType(postType);
      locator.pageId = editorsPageId;
      locator.postNr = state.replyToPostNrs[0]; // for now just pick the first one
      locator.postId = store_getPostId(mainStore, locator.pageId, locator.postNr);
      // This is needed for embedded comments, if the discussion page hasn't yet been created.
      if (eds.embeddingUrl) {
        locator.embeddingUrl = eds.embeddingUrl;
      }
    }
    else if (state.isWritingChatMessage) {
      locator.draftType = DraftType.Reply;
      locator.pageId = editorsPageId;
      locator.postNr = BodyNr;
      locator.postId = store_getPostId(mainStore, locator.pageId, locator.postNr);
      postType = PostType.ChatMessage;
    }
    else if (state.messageToUserIds && state.messageToUserIds.length) {
      locator.draftType = DraftType.DirectMessage;
      locator.toUserId = state.messageToUserIds[0];  // for now
    }
    else if (state.newForumTopicCategoryId) {
      locator.draftType = DraftType.Topic;
      locator.categoryId = state.newForumTopicCategoryId;
      // Need to know in which forum (sub community) the new page should be placed.
      // (Hmm or could lookup via category id?)
      locator.pageId = editorsPageId;
    }
    else {
      // Editor probably closed, state gone.
      return;
    }

    const draft: Draft = {
      byUserId: mainStore.me.id,
      draftNr: NoDraftNr,
      forWhat: locator,
      createdAt: getNowMs(),
      topicType: state.newPageRole,
      postType: state.anyPostType || postType,
      title: '',
      text: '',
    };

    return draft;
  },

  saveDraftUseBeacon: function() {
    console.debug("saveDraftUseBeacon");
    this.saveDraftNow(undefined, UseBeacon);
  },

  saveDraftNow: function(callbackThatClosesEditor: (draft?: Draft) => void,
      useBeacon?: UseBeacon) {
    // Tested here: 7WKABZP2
    // A bit dupl code [4ABKR2J0]
    const state: EditorState = this.state;

    // If we're closing the page, do try saving anyway, using becaon, because the current non-beacon
    // request will probably be aborted by the browser (since, if beacon, the page is getting unloaded).
    if (this.isSavingDraft && !useBeacon) {
      console.debug("isSavingDraft already.");
      return;
    }

    const oldDraft: Draft | undefined = state.draft;
    const draftOldOrEmpty: Draft | undefined = oldDraft || this.makeEmptyDraft();
    const draftStatus: DraftStatus = state.draftStatus;

    if (!draftOldOrEmpty || draftStatus <= DraftStatus.NeedNotSave) {
      console.debug("Need not save draft, because: !!draftOldOrEmpty: " +
          !!draftOldOrEmpty + " draftStatus: " + draftStatus);
      if (callbackThatClosesEditor) {
        callbackThatClosesEditor(oldDraft);
      }
      return;
    }

    const text: string = (state.text || '').trim();
    const title: string = (state.title || '').trim();

    // BUG the lost update bug, unlikely to happen: Might overwrite other version of this draft [5KBRZ27]
    // which might be open in another browser tab. Could have the server check if there's
    // a newer version of the draft (saved in another browser tab) and, if so, ask if
    // wants to overwrite or not?  [5ABRQP0]  — This happens to me sometimes actually, in Facebook,
    // when composing replies there; FB has this lost-updates bug in their editor (2018)?

    // Delete any old draft, if text empty.
    if (!text && !title) {
      if (oldDraft) {
        console.debug("Deleting draft...");
        this.setState({
          // When closing editor, after having deleted all text, it's rather uninteresting
          // that the draft gets deleted — don't show a modal dialog about that.
          // Still a bit interesting? so if editor still open, do show a small non-obtrusive
          // info about the draft getting deleted.
          draftStatus: callbackThatClosesEditor ?
              DraftStatus.NothingHappened : DraftStatus.Deleting,
        });
        this.isSavingDraft = true;

        // Deleting the draft post, would in fact delete the edits preview
        // instead — because now when editing, the draft post has been temporarily
        // removed and there's a preview (with the same post nr) instead.
        const deleteDraftPost = false;

        ReactActions.deleteDraft(
            state.editorsPageId, oldDraft, deleteDraftPost, useBeacon || (() => {
          this.isSavingDraft = false;
          console.debug("...Deleted draft.");

          // Could patch the store: delete the draft — so won't reappear
          // if [offline-first] and navigates back to this page.

          const state: EditorState = this.state;
          if (this.isGone || !state.visible)
            return;

          this.setState({
            draft: null,
            draftStatus: DraftStatus.Deleted,
          });
        }), useBeacon || this.setCannotSaveDraft);
      }
      if (callbackThatClosesEditor) {
        callbackThatClosesEditor();
      }
      return;
    }

    const store: Store = state.store;
    const draftToSave: Draft = { ...draftOldOrEmpty, text, title };

    // If this is an embedded comments discussion, and the discussion page hasn't
    // yet been created, there's no page id to use as draft locator key. Then,
    // save the draft in the browser storage only, for now.
    // UX COULD save server side, with url as key  [BLGCMNT1]
    // — it's the key already, in the sesison cache.
    const saveInBrowser =
        !store.me.isLoggedIn || isEmbeddedNotYetCreatedPage(state);

    console.debug(`Saving draft: ${JSON.stringify(draftToSave)}, ` + (
        saveInBrowser ? "temp in browser" : "server side"));

    if (saveInBrowser) {
      BrowserStorage.set(draftToSave.forWhat, draftToSave);
      this.setState({
         draft: draftToSave,
         draftStatus: DraftStatus.SavedInBrowser,
      });
      if (callbackThatClosesEditor) {
        callbackThatClosesEditor(draftToSave);
      }
      return;
    }

    this.setState({
      draftStatus: callbackThatClosesEditor ?
          DraftStatus.SavingBig : DraftStatus.SavingSmall,
    });

    this.isSavingDraft = true;
    Server.upsertDraft(draftToSave, useBeacon || ((draftWithNr: Draft) => {
      this.isSavingDraft = false;
      console.debug("...Saved draft.");

      const state: EditorState = this.state;
      if (this.isGone || !state.visible)
        return;

      this.setState({
        draft: draftWithNr,
        draftStatus: DraftStatus.SavedServerSide,
      });

      if (callbackThatClosesEditor) {
        callbackThatClosesEditor(draftWithNr);
      }
    }), useBeacon || this.setCannotSaveDraft);
  },

  setCannotSaveDraft: function(errorStatusCode?: number) {
    // Dupl code [4ABKR2JZ7]
    this.isSavingDraft = false;
    this.setState({
      draftStatus: DraftStatus.CannotSave,
      draftErrorStatusCode: errorStatusCode,
    });
  },

  onSaveClick: function() {
    this.saveStuff();
  },

  saveStuff: function() {
    const state: EditorState = this.state;
    const isReplying = state.replyToPostNrs.length > 0;
    const loginToWhat = eds.isInEmbeddedEditor && isReplying ?
      LoginReason.PostEmbeddedComment : LoginReason.SubmitEditorText;

    // Email verification shouldn't be needed immediately, checked by this constraint:
    // settings3_compose_before_c. However, there's a RACE condition: a user clicks Reply,
    // starts composing without having logged in, then an admin changes the settings
    // to may-NOT-compose-before-logged-in, and then the user clicks Post Reply. Then,
    // #dummy below might get used, but won't work.
    debiki2.login.loginIfNeededReturnToAnchor(loginToWhat, '#dummy-TyE2PBBYL0', () => {
      const state: EditorState = this.state;
      if (page_isPrivateGroup(state.newPageRole)) {
        this.startPrivateGroupTalk();
      }
      else if (state.newForumTopicCategoryId) {
        this.saveNewForumPage();
      }
      else if (_.isNumber(state.editingPostNr)) {
        this.saveEdits();
      }
      else if (state.isWritingChatMessage) {
        this.postChatMessage();
      }
      else {
        // Replying to someone.
        this.saveNewPost();
      }
    });
  },

  saveEdits: function() {
    this.throwIfBadTitleOrText(null, t.e.PleaseDontDeleteAll);
    const state: EditorState = this.state;
    Server.saveEdits(state.editorsPageId, state.editingPostNr, state.text,
          this.anyDraftNr(), () => {
      // BUG (harmless) poor UX: [JMPBCK] If we're no longer on the same page as
      // the post we were editing (e.g. because keeping the editor open and
      // navigating away) then, one won't see the edits appear. Probably should
      // navigate back to the post that got edited? First show a popup:
      //   "Go back and view the now edited post? It's on another page;
      //   you have navigated away frome it, to here""
      this.callOnDoneCallback(true);
      this.clearAndClose(); // [6027TKWAPJ5]
    });
  },

  saveNewPost: function() {
    this.throwIfBadTitleOrText(null, t.e.PleaseWriteSth);
    const state: EditorState = this.state;
    ReactActions.saveReply(state.editorsPageId, state.replyToPostNrs, state.text,
          state.anyPostType, state.draft, () => {
      // BUG (harmless) poor UX: See [JMPBCK] aboe.
      // Also, if we've navigaated away, seems any draft won't get deleted.
      this.callOnDoneCallback(true);
      this.clearAndClose();
    });
  },

  saveNewForumPage: function() {
    const state: EditorState = this.state;
    this.throwIfBadTitleOrText(t.e.PleaseWriteTitle, t.e.PleaseWriteSth);
    const data = {
      categoryId: state.newForumTopicCategoryId,
      pageRole: state.newPageRole,
      pageStatus: 'Published',
      pageTitle: state.title,
      pageBody: state.text,
      deleteDraftNr: this.anyDraftNr(),
    };
    Server.createPage(data, (newPageId: string) => {
      // Could, but not needed, since assign() below:
      //   this.callOnDoneCallback(true);
      this.clearAndClose();
      window.location.assign('/-' + newPageId);
    });
  },

  postChatMessage: function() {
    const state: EditorState = this.state;
    ReactActions.insertChatMessage(state.text, state.draft, () => {
      this.callOnDoneCallback(true);
      this.clearAndClose();
    });
  },

  startPrivateGroupTalk: function() {
    this.throwIfBadTitleOrText(t.e.PleaseWriteMsgTitle, t.e.PleaseWriteMsg);
    const state: EditorState = this.state;
    Server.startPrivateGroupTalk(state.title, state.text, state.newPageRole,
        state.messageToUserIds, this.anyDraftNr(), (pageId: PageId) => {
      // Could, but not needed, since assign() below:
      //   this.callOnDoneCallback(true);
      this.clearAndClose();
      window.location.assign('/-' + pageId);
    });
  },

  anyDraftNr: function(): DraftNr | undefined {
    const state: EditorState = this.state;
    const draft: Draft | undefined = state.draft;
    if (draft) return draft.draftNr;
  },

  throwIfBadTitleOrText: function(titleErrorMessage, textErrorMessage) {
    const state: EditorState = this.state;
    let errors = '';
    if (titleErrorMessage && isBlank(state.title)) {
      errors += titleErrorMessage;
      this.setState({ showTitleErrors: true });
    }
    if (textErrorMessage && isBlank(state.text)) {
      if (errors) errors += ' ';
      errors += textErrorMessage;
      this.setState({ showTextErrors: true });
    }
    if (errors) {
      util.openDefaultStupidDialog({ body: errors });
      throw 'Bad title or text. Not saving this to the server. [EsM7KCW]';
    }
  },

  cycleMaxHorizBack: function() {
    // Cycle from 1) normal to 2) maximized & tiled vertically, to 3) maximized & tiled horizontally
    // and then back to normal.
    const state: EditorState = this.state;
    const newShowMaximized = !state.showMaximized || !state.splitHorizontally;
    if (eds.isInEmbeddedEditor && newShowMaximized !== state.showMaximized) {
      window.parent.postMessage(JSON.stringify(['maximizeEditor', newShowMaximized]),
          eds.embeddingOrigin);
    }
    this.setState({
      showMaximized: !state.showMaximized || !state.splitHorizontally,
      splitHorizontally: state.showMaximized && !state.splitHorizontally,
    });
  },

  togglePreview: function() {
    const state: EditorState = this.state;
    this.setState({
      showOnlyPreview: !state.showOnlyPreview,
      showMinimized: false,
    });
  },

  toggleMinimized: function() {
    const nextShowMini = !this.state.showMinimized;
    if (eds.isInEmbeddedEditor) {
      window.parent.postMessage(JSON.stringify(['minimizeEditor', nextShowMini]), eds.embeddingOrigin);
    }
    this.setState({ showMinimized: nextShowMini });
    if (nextShowMini) {
      // Wait until after new size has taken effect.
      setTimeout(this.makeSpaceAtBottomForEditor);
    }
    // Else: the editor covers 100% anyway.
  },

  showEditor: function(statePatch: Partial<EditorState>) {
    // @ifdef DEBUG
    dieIf(!_.isUndefined(statePatch.visible), 'TyE305WKTJP4');
    // @endif
    this.makeSpaceAtBottomForEditor();
    const oldState: EditorState = this.state;
    const newState: Partial<EditorState> = { ...statePatch, visible: true };
    this.setState(newState);

    const params: EditorPatch = {
      editorsPageId: newState.editorsPageId || oldState.editorsPageId,
      replyingToPostNr: newState.replyToPostNrs?.[0],
      editingPostId: newState.editingPostUid,
    };
    ReactActions.onEditorOpen(params, () => {
      if (this.isGone || !this.state.visible) return;
      this.focusInputFields();
      this.scrollToPreview = true;
      this.updatePreviewSoon();
    });
  },

  saveDraftClearAndClose: function() {
    this.saveDraftNow(
        (upToDateDraft?: Draft) => this.clearAndClose({ keepDraft: true, upToDateDraft }));
  },

  clearAndClose: function(ps: { keepDraft?: true, upToDateDraft?: Draft } = {}) {
    const state: EditorState = this.state;
    const anyDraft: Draft = ps.upToDateDraft || state.draft;

    if (!ps.keepDraft && anyDraft) {
      const deleteDraftPost = true;
      ReactActions.deleteDraft(state.editorsPageId, anyDraft, deleteDraftPost);
    }

    const params: HideEditorAndPreviewParams = {
      anyDraft,
      keepDraft: ps.keepDraft,
      editorsPageId: state.editorsPageId,
    };

    const postNrs: PostNr[] = state.replyToPostNrs;
    if (postNrs.length === 1) {
      params.replyToNr = postNrs[0];
      params.anyPostType = state.anyPostType;
    }

    if (state.editingPostUid) {
      params.editingPostNr = state.editingPostNr;
    }

    if (state.isWritingChatMessage) {
      // Then we'll continue typing, in the simple chat message text box.
      params.keepPreview = true;
    }

    // Hide any preview we created when opening the editor (TGLPRVW),
    // and reenable any Reply buttons.
    ReactActions.hideEditorAndPreview(params);

    this.returnSpaceAtBottomForEditor();

    if (this.isGone)
      return;

    this.setState({
      visible: false,
      replyToPostNrs: [],
      anyPostType: undefined,
      editorsCategories: null,
      editorsPageId: null,
      editingPostNr: null,
      editingPostUid: null,
      isWritingChatMessage: false,
      messageToUserIds: [],
      newForumTopicCategoryId: null,
      newPageRole: null,
      editingPostRevisionNr: null,
      text: '',
      title: '',
      showTitleErrors: false,
      showTextErrors: false,
      draftStatus: DraftStatus.NotLoaded,
      draft: null,
      safePreviewHtml: '',
      onDone: null,
      guidelines: null,
      backdropOpacity: 0,
    });
  },

  callOnDoneCallback: function(saved: boolean) {
    const onDone: EditsDoneHandler = this.state.onDone;
    if (onDone) {
      onDone(
          saved, this.state.text,
          // If the text in the editor was saved (i.e. submitted, not draft-saved), we don't
          // need the draft any longer.
          saved ? null : this.state.draft,
          saved ? DraftStatus.NothingHappened : this.state.draftStatus);
    }
  },

  showEditHistory: function() {
    dieIf(!this.state.editingPostNr || !this.state.editingPostUid, 'EdE5UGMY2');
    debiki2.edithistory.getEditHistoryDialog().open(this.state.editingPostUid);
  },

  makeTextBold: function() {
    const newText = wrapSelectedText(this.refs.rtaTextarea.textareaRef, t.e.exBold, '**');
    this.setState({ text: newText }, this.updatePreviewSoon);
  },

  makeTextItalic: function() {
    const newText = wrapSelectedText(this.refs.rtaTextarea.textareaRef, t.e.exEmph, '*');
    this.setState({ text: newText }, this.updatePreviewSoon);
  },

  markupAsCode: function() {
    const newText = wrapSelectedText(this.refs.rtaTextarea.textareaRef, t.e.exPre, '`');
    this.setState({ text: newText }, this.updatePreviewSoon);
  },

  quoteText: function() {
    const newText = wrapSelectedText(this.refs.rtaTextarea.textareaRef, t.e.exQuoted, '> ', null, '\n\n');
    this.setState({ text: newText }, this.updatePreviewSoon);
  },

  addHeading: function() {
    const newText = wrapSelectedText(this.refs.rtaTextarea.textareaRef, t.e.ExHeading, '### ', null, '\n\n');
    this.setState({ text: newText }, this.updatePreviewSoon);
  },

  render: function() {
    const state: EditorState = this.state;
    const store: Store = state.store;

    // Is undef, if in the API section, e.g. typing a direct message to a user.
    const editorsPage: Page | undefined =
        store.pagesById[state.editorsPageId] || store.currentPage;

    const editorsPageType: PageType | undefined = editorsPage?.pageRole;

    const me: Myself = store.me;
    const myUiPrefs: UiPrefs = me_uiPrefs(me);
    let settings: SettingsVisibleClientSide = store.settings;
    const isPrivateGroup = page_isPrivateGroup(state.newPageRole);

    // We'll disable the editor, until any draft has been loaded. [5AKBW20] Otherwise one might
    // start typing, and then the draft gets loaded (which might take some seconds if
    // the server was just started, or maybe slow connection) and overwrites the text one
    // has already typed.
    const draftStatus: DraftStatus = state.draftStatus;
    const anyDraftLoaded = draftStatus !== DraftStatus.NotLoaded;


    // ----- Guidelines?

    const guidelines = state.guidelines;
    let guidelinesElem;
    let showGuidelinesBtn;
    if (guidelines && guidelines.safeHtml) {
      if (guidelines.hidden) {
        showGuidelinesBtn =
          r.a({ className: 'icon-info-circled', onClick: this.showGuidelines });
      }
      else if (state.showGuidelinesInModal) {
        // Skip the post-it style guidelines just below.
      }
      else {
        guidelinesElem =
          r.div({ className: 'dw-editor-guidelines-wrap', ref: 'guidelines' },
            r.div({ className: 'dw-editor-guidelines clearfix' },
              r.div({ className: 'dw-editor-guidelines-text',
                dangerouslySetInnerHTML: { __html: state.guidelines.safeHtml }}),
              r.a({ className: 'icon-cancel dw-hide', onClick: this.hideGuidelines }, t.Hide)));
      }
    }

    const guidelinesModal = GuidelinesModal({ guidelines,
        isOpen: guidelines && state.showGuidelinesInModal, close: this.hideGuidelines });


    // ----- Similar topics?

    let similarTopicsTips;
    const searchResults: SearchResults = state.searchResults;

    if (searchResults && state.showSimilarTopics) {
      const urlEncodedQuery = debiki2['search'].urlEncodeSearchQuery(state.title);
      const searchUrl = '/-/search?q=' + urlEncodedQuery;

      const hitList = !searchResults.pagesAndHits.length ? null :
          r.ul({},
            _.take(searchResults.pagesAndHits, 15).map((pageAndHits: PageAndHits) =>
              r.li({ key: pageAndHits.pageId, className: 's_E_SimlTpcs_L_It' },
                r.a({ href: '/-' + pageAndHits.pageId, target: '_blank' },
                  pageAndHits.pageTitle))));

      similarTopicsTips = !hitList ? null :
        r.div({ className: 's_E_SimlTpcs' },
          r.h4({}, t.e.SimilarTopicsC),
          r.a({ className: 'icon-cancel dw-hide s_E_SimlTpcs_HideB',
              onClick: () => this.setState({ showSimilarTopics: false }) },
            t.Hide),
          r.a({ className: 'icon-search dw-hide s_E_SimlTpcs_SearchB', href: searchUrl,
              target: '_blank' },
            t.Search),
          hitList);
    }

    // Sometimes it's hard to notice that the editor opens. But by making everything very dark,
    // except for the editor, people will see it for sure. We'll make everything dark only for
    // a short while.
    const anyBackdrop = state.backdropOpacity < 0.01 ? null :
        r.div({ className: 'esEdtr_backdrop', style: { opacity: state.backdropOpacity }});


    // ----- Title, page type, category

    let titleInput;
    let pageRoleDropdown;
    let categoriesDropdown;
    if (state.newForumTopicCategoryId || isPrivateGroup) {
      const titleErrorClass = state.showTitleErrors && !this.isTitleOk() ? ' esError' : '';
      titleInput =
          r.input({ className: 'title-input esEdtr_titleEtc_title form-control' + titleErrorClass,
              type: 'text', ref: 'titleInput', tabIndex: 1, onChange: this.onTitleEdited,
              value: state.title, disabled: !anyDraftLoaded,
              placeholder: t.e.TitlePlaceholder,
              onKeyPress: this.onKeyPressOrKeyDown,
              onKeyDown: this.onKeyPressOrKeyDown,
            });

      if (state.newForumTopicCategoryId && !isPrivateGroup &&
          settings_showCategories(settings, me))
        categoriesDropdown =
          SelectCategoryDropdown({ className: 'esEdtr_titleEtc_category', store: store,
              categories: state.editorsCategories,
              selectedCategoryId: state.newForumTopicCategoryId,
              onCategorySelected: this.changeCategory });

      if (state.newPageRole && settings_selectTopicType(settings, me)) {
        pageRoleDropdown = PageRoleDropdown({ store, pageRole: state.newPageRole,
            complicated: store.settings.showExperimental,
            onSelect: this.changeNewForumPageRole,
            title: t.TopicType, className: 'esEdtr_titleEtc_pageRole' });
      }
    }

    const editingPostNr = state.editingPostNr;
    const replyToPostNrs = state.replyToPostNrs;
    const isOrigPostReply = _.isEqual([BodyNr], replyToPostNrs);
    const repliesToNotOrigPost = replyToPostNrs.length && !isOrigPostReply;

    // The page might not yet have been created — it's just {} before it gets
    // saved and lazy-created [EMBED0PG]. However, in such a situation, we're inside
    // the editor iframe, at the blog (not at the Talkyard site).
    const isBlogPostReply = isOrigPostReply && (
        // Might not work, at the blog:
        editorsPage?.pageRole === PageRole.EmbeddedComments ||
        // Works, but only at the blog:
        eds.isInEmbeddedEditor);

    // ----- Delete these?:
    const isChatComment = replyToPostNrs.length === 1 && replyToPostNrs[0] === NoPostId;
    const isMindMapNode = replyToPostNrs.length === 1 && editorsPage.pageRole === PageRole.MindMap;
    // --------------------


    // ----- "Reply to" or "Editing" text

    let doingWhatInfo: any;
    if (_.isNumber(editingPostNr)) {
      doingWhatInfo =
        r.span({},
          // "Edit post X:"
          t.e.EditPost_1,
          // Dupl code, break out fn? [306KUGSTRR3]  <a href='#post-..'>  + onClick preventDefault?
          r.a({ href: '#post-' + editingPostNr,
              onMouseEnter: () => ReactActions.highlightPost(editingPostNr, true),
              onMouseLeave: () => ReactActions.highlightPost(editingPostNr, false),
              onClick: (event) => {
                event.preventDefault();
                ReactActions.scrollAndShowPost(editingPostNr);
              }},
            t.e.EditPost_2 + editingPostNr + ':'));
    }
    else if (state.isWritingChatMessage) {
      doingWhatInfo = t.e.TypeChatMsg;
    }
    else if (state.messageToUserIds.length) {
      doingWhatInfo = t.e.YourMsg;
    }
    else if (state.newPageRole) {
      let what = t.e.CreateTopic;
      switch (state.newPageRole) {
        case PageRole.CustomHtmlPage: what = t.e.CreateCustomHtml; break;
        case PageRole.WebPage: what = t.e.CreateInfoPage; break;
        case PageRole.Code: what = t.e.CreateCode; break;
        case PageRole.SpecialContent: die('DwE5KPVW2'); break;
        case PageRole.EmbeddedComments: die('DwE2WCCP8'); break;
        case PageRole.Blog: die('DwE2WQB9'); break;
        case PageRole.Forum: die('DwE5JKF9'); break;
        case PageRole.About: die('DwE1WTFW8'); break;
        case PageRole.Question: what = t.e.AskQuestion; break;
        case PageRole.Problem: what = t.e.ReportProblem; break;
        case PageRole.Idea: what = t.e.SuggestIdea; break;
        case PageRole.ToDo: what = "Create a todo"; break;
        case PageRole.OpenChat: what = t.e.NewChat; break;
        case PageRole.PrivateChat: what = t.e.NewPrivChat; break;
        case PageRole.MindMap: what = "Create a mind map page"; break;
        case PageRole.Discussion: break; // use default
        case PageRole.FormalMessage: die('EsE2KFE78'); break;
        case PageRole.UsabilityTesting: what = "Do usability testing"; break; // [plugin]
      }
      doingWhatInfo = what + ":";
    }
    else if (replyToPostNrs.length === 0) {
      doingWhatInfo = t.e.PleaseSelectPosts;
    }
    else if (isChatComment) {
      doingWhatInfo = "New chat comment:";
    }
    else if (isOrigPostReply && page_isUsabilityTesting(editorsPage.pageRole)) { // [plugin]
      //doingWhatInfo = "Your usability testing video link + description:";
      doingWhatInfo = "Your feedback and answers to questions:";
    }
    else if (isMindMapNode) {
      doingWhatInfo = "Add mind map node:";
    }
    else if (state.anyPostType === PostType.BottomComment && !repliesToNotOrigPost) {
      doingWhatInfo = t.e.AppendComment;
    }
    else if (isBlogPostReply) {
      // Blog post author name is unknown. (There's an orig post by System,
      // but "Replying to @system" would be incorrect.)
      doingWhatInfo = t.e.AddCommentC;
    }
    else if (replyToPostNrs.length > 0) {
      doingWhatInfo =
        r.span({},
          t.e.ReplyTo,
          _.filter(replyToPostNrs, (id) => id !== NoPostId).map((replToPostNr, index) => {
            // If replying to a blog post, then, it got auto created by the System
            // user. Don't show "Reply to System".
            let replToPost: Post | undefined;

            let replToAuthor: BriefUser | undefined;
            if (eds.isInEmbeddedEditor) {
              // Here in the embedded editor, we haven't loaded any page or author names
              // — get them from the main iframe instead (the one with all the comments).
              // This is a new and a bit odd approach? (Jan 2020.) Let's wrap in try (although
              // shouldn't be needed).)
              //
              // REFACTOR CLEAN_UP don't send just a postNr to the editor,
              // instead send:
              //     { replyingToPost: Post, replyingToAuthor: Participant }   ? + page id ?
              // then can skip all this (!),
              // plus, post remembered, also if navigating to other page.
              //
              try {
                replToPost = state.embMainStoreCopy.currentPage.postsByNr[replToPostNr];
                replToAuthor = replToPost && store_getAuthorOrMissing(
                    state.embMainStoreCopy as Store, replToPost);
              }
              catch (ex) {
                if (!this.loggedStoreCloneWarning) {
                  console.warn("Error getting author name from main iframe store clone", ex);
                  debugger;
                  this.loggedStoreCloneWarning = true;
                }
              }
            }
            else {
              replToPost = editorsPage?.postsByNr[replToPostNr];
              replToAuthor = replToPost && store_getAuthorOrMissing(store, replToPost);
            }

            let replyingToWhat;
            if (replToAuthor) {
              replyingToWhat = UserName({ user: replToAuthor, store,
                  makeLink: false, onClick: null, avoidFullName: true });
            }
            else {
              replyingToWhat = replToPostNr === BodyNr ?
                  t.e.ReplyTo_theOrigPost : t.e.ReplyTo_post + replToPostNr;
            }

            const anyAnd = index > 0 ? " and " : '';
            return (
              (<any> r.span)({ key: replToPostNr },   // span has no .key, weird [TYPEERROR]
                anyAnd,
                // Dupl code, break out fn? [306KUGSTRR3]  <a href='#post-..'>  + onClick preventDefault?
                r.a({
                  onMouseEnter: () => ReactActions.highlightPost(replToPostNr, true),
                  onMouseLeave: () => ReactActions.highlightPost(replToPostNr, false),
                  onClick: !replToPost ? undefined : function() {
                    ReactActions.scrollAndShowPost(replToPost);
                  }},
                  replyingToWhat)));
          }),
          ':');
    }


    // ----- Save button

    function makeSaveTitle(brief, extra) {
      if (!extra) return brief;
      return r.span({}, brief, r.span({ className: 'esE_SaveB_Verbose' }, ' ' + extra));
    }

    let saveButtonTitle = t.Save;
    let cancelButtonTitle = t.Cancel;  // UX should be entitled  t.SaveDraft  instead?  I18N
    if (_.isNumber(editingPostNr)) {
      saveButtonTitle = makeSaveTitle(t.e.Save, t.e.edits);
    }
    else if (isBlogPostReply) {
      saveButtonTitle = t.e.PostComment || t.e.PostReply;   // I18N  t.e.PostComment missing
    }
    else if (replyToPostNrs.length) {
      if (isChatComment) {
        saveButtonTitle = makeSaveTitle(t.e.Post, t.e.comment);
      }
      else if (isMindMapNode) {
        saveButtonTitle = makeSaveTitle("Add", " node");
      }
      else {
        saveButtonTitle = t.e.PostReply;
        if (isOrigPostReply && page_isUsabilityTesting(editorsPage.pageRole)) { // [plugin]
          //saveButtonTitle = makeSaveTitle("Submit", " video");
          saveButtonTitle = makeSaveTitle("Submit", " feedback");
        }
      }
    }
    else if (state.isWritingChatMessage) {
      saveButtonTitle = t.e.PostMessage;
      cancelButtonTitle = t.e.SimpleEditor;
    }
    else if (state.messageToUserIds.length) {
      saveButtonTitle = makeSaveTitle(t.e.Send, t.e.message);
    }
    else if (state.newPageRole) {
      switch (state.newPageRole) {
        case PageRole.CustomHtmlPage:
        case PageRole.WebPage:
        case PageRole.Code:
          saveButtonTitle = makeSaveTitle(t.e.Create, t.e.page);
          break;
        case PageRole.OpenChat:
        case PageRole.PrivateChat:
          saveButtonTitle = makeSaveTitle(t.e.Create, t.e.chat);
          break;
        case PageRole.Question: saveButtonTitle = makeSaveTitle(t.e.Post, t.e.question); break;
        case PageRole.Problem: saveButtonTitle = makeSaveTitle(t.e.Submit, t.e.problem); break;
        case PageRole.Idea: saveButtonTitle = makeSaveTitle(t.e.Create, t.e.idea); break;
        case PageRole.ToDo: saveButtonTitle = makeSaveTitle("Create", " to-do"); break;
        case PageRole.MindMap: saveButtonTitle = makeSaveTitle("Create", " mind map"); break;
        default:
          saveButtonTitle = makeSaveTitle(t.e.Create, t.e.topic);
      }
    }


    // ----- Misc (move elsewhere?)

    let anyViewHistoryButton;
    if (state.editingPostRevisionNr && state.editingPostRevisionNr !== 1) {
      anyViewHistoryButton =
          r.a({ onClick: this.showEditHistory, className: 'view-edit-history', tabIndex: 1 },
            t.e.ViewOldEdits);
    }

    // If not visible, don't remove the editor, just hide it, so we won't have
    // to unrigister the mentions parser (that would be boring).
    const styles = {
      display: state.visible ? 'block' : 'none'
    };


    // ----- Textarea and editor buttons

    const textareaButtons =
      r.div({ className: 'esEdtr_txtBtns' },
        r.button({ onClick: this.selectAndUploadFile, title: t.e.UploadBtnTooltip,
            className: 'esEdtr_txtBtn' },
          r.span({ className: 'icon-upload' })),
        r.input({ name: 'files', type: 'file', multiple: false, // dupl code [2UK503]
          ref: 'uploadFileInput', style: { width: 0, height: 0, float: 'left' }}),
        r.button({ onClick: this.makeTextBold, title: t.e.BoldBtnTooltip,
            className: 'esEdtr_txtBtn' }, 'B'),
        r.button({ onClick: this.makeTextItalic, title: t.e.EmBtnTooltip,
          className: 'esEdtr_txtBtn esEdtr_txtBtn-em' }, r.i({}, 'I')),
        r.button({ onClick: this.quoteText, title: t.e.QuoteBtnTooltip,
          className: 'esEdtr_txtBtn' }, '"'),
        r.button({ onClick: this.markupAsCode, title: t.e.PreBtnTooltip,
          className: 'esEdtr_txtBtn' }, r.span({ className: 'icon-code' })),
        r.button({ onClick: this.addHeading, title: t.e.HeadingBtnTooltip,
            className: 'esEdtr_txtBtn' }, 'H'));

    const textErrorClass = state.showTextErrors && !this.isTextOk() ? ' esError' : '';
    const textarea =
        !anyDraftLoaded ? r.pre({ className: 'e_LdDft' }, t.e.LoadingDraftDots) :
          ReactTextareaAutocomplete({
            className: 'editor form-control esEdtr_textarea' +  textErrorClass,
            ref: 'rtaTextarea',
            value: state.text,
            onChange: this.onTextEdited,
            onKeyPress: this.onKeyPressOrKeyDown,
            onKeyDown: this.onKeyPressOrKeyDown,
            closeOnClickOutside: true,
            tabIndex: 1,
            placeholder: t.e.TypeHerePlaceholder,
            loadingComponent: () => r.span({}, t.Loading),
            // Currently the server says Forbidden unless one is logged in, when listing usernames.
            // UX COULD list usernames of users already loaded & visible anyway, if not logged in?
            trigger: me.isLoggedIn ? listUsernamesTrigger : {} });


    // ----- Preview

    const thereIsAnInPagePreview =
        me_uiPrefs(me).inp !== UiPrefsIninePreviews.Skip &&
        // If we're creating a new page, there's not any place to show an in-page preview.
        !state.newForumTopicCategoryId;

    // Don't show any in-editor preview, if we're showing an in-page preview,
    // and hasn't configured double previews (in editor too).
    const skipInEditorPreview =
        thereIsAnInPagePreview &&
        myUiPrefs.inp !== UiPrefsIninePreviews.Double &&
        // If the editor is full screen (i.e. textarea and preview split screen),
        // then show an in-editor preview as usual.
        !(state.showMaximized || state.splitHorizontally || state.showOnlyPreview);

    const previewHelp = skipInEditorPreview ? null :
        r.div({ className: 'dw-preview-help' },
          help.HelpMessageBox({ message: previewHelpMessage }));

    const previewTitleTagName = !thereIsAnInPagePreview ? 'span' : 'a';

    const scrollToPreviewProps = !thereIsAnInPagePreview ? {} : {
      onMouseEnter: () => ReactActions.highlightPreview(true),
      onMouseLeave: () => ReactActions.highlightPreview(false),
      onClick: () => {
        ReactActions.scrollToPreview({
          isEditingBody: state.editingPostNr === BodyNr,
          isChat: page_isChat(editorsPageType),
        });
      },
    };

    const previewTitle = skipInEditorPreview ? null :
        r.div({},
          r[previewTitleTagName](scrollToPreviewProps,
            t.e.PreviewC + (titleInput ? t.e.TitleExcl : '')));

    // If no in-editor preview, instead well include a "Scroll to preview" button
    // above the textarea.
    const scrollToPreviewBtn = !skipInEditorPreview || !thereIsAnInPagePreview ? null :
        r.a({ ...scrollToPreviewProps, className: 's_E_ScrPrvwB' }, t.ShowPreview);

    let editorClasses = skipInEditorPreview ? 's_E-NoInEdPrvw' : 's_E-WithInEdPrvw';


    // ----- Editor size

    editorClasses += eds.isInEmbeddedEditor ? '' : ' editor-box-shadow';
    editorClasses += state.showMaximized ? ' s_E-Max' : '';
    editorClasses += state.splitHorizontally ? ' s_E-SplitHz' : '';
    editorClasses += state.showMinimized ? ' s_E-Min' : (
        state.showOnlyPreview ? ' s_E-Prv' : ' s_E-E');

    const editorStyles = state.showOnlyPreview ? { display: 'none' } : null;
    const previewStyles = state.showOnlyPreview ? { display: 'block' } : null;

    const maximizeAndHorizSplitBtnTitle =
        !state.showMaximized ? t.e.Maximize : (
          state.splitHorizontally ? t.e.ToNormal : t.e.TileHorizontally);


    // ----- Draft status

    const draft: Draft = state.draft;
    const draftNr = draft ? draft.draftNr : NoDraftNr;

    const draftStatusText =
        DraftStatusInfo({
          draftStatus, draftNr, draftErrorStatusCode: state.draftErrorStatusCode });


    // ----- The result

    return (
      r.div({ style: styles },
        guidelinesModal,
        anyBackdrop,
        r.div({ id: 'debiki-editor-controller', ref: 'editor',
            className: editorClasses },
          r.button({ className: 'esEdtr_close esCloseCross', onClick: this.onCancelClick }),
          guidelinesElem,
          similarTopicsTips,
          r.div({ id: 'editor-after-borders' },
            r.div({ className: 'editor-area', style: editorStyles },
              r.div({ className: 'editor-area-after-borders' },
                r.div({ className: 's_E_DoingRow' },
                  r.span({ className: 's_E_DoingWhat' }, doingWhatInfo),
                  showGuidelinesBtn,
                  scrollToPreviewBtn,
                  draftStatusText),
                r.div({ className: 'esEdtr_titleEtc' },
                  // COULD use https://github.com/marcj/css-element-queries here so that
                  // this will wrap to many lines also when screen wide but the editor is narrow.
                  titleInput,
                  // Wrap in a div so will appear on the same line also when flex-dir = column.
                  r.div({},
                    categoriesDropdown,
                    pageRoleDropdown)),
                textareaButtons,
                textarea)),
             skipInEditorPreview ? null :
               r.div({ className: 'preview-area', style: previewStyles },
                previewTitle,
                previewHelp,
                r.div({ className: 'preview', id: 't_E_Preview', ref: 'preview',
                    dangerouslySetInnerHTML: { __html: state.safePreviewHtml }})),
            r.div({ className: 'submit-cancel-btns' },
              PrimaryButton({ onClick: this.onSaveClick, tabIndex: 1, className: 'e_E_SaveB' },
                saveButtonTitle),
              Button({ onClick: this.onCancelClick, tabIndex: 1, className: 'e_EdCancelB' },
                cancelButtonTitle),
              Button({ onClick: this.cycleMaxHorizBack, className: 'esEdtr_cycleMaxHzBtn',
                  tabIndex: 4 }, maximizeAndHorizSplitBtnTitle),
              // These two buttons are hidden via CSS if the window is wide. Higher tabIndex
              // because float right.
              Button({ onClick: this.toggleMinimized, id: 'esMinimizeBtn',
                  primary: state.showMinimized, tabIndex: 3 },
                state.showMinimized ? t.e.ShowEditorAgain : t.e.Minimize),
              Button({ onClick: this.togglePreview, id: 'esPreviewBtn', tabIndex: 2 },
                state.showOnlyPreview ? t.EditV : t.PreviewV),
              anyViewHistoryButton)),
            r.div({ className: 's_E_iPhoneKbd' },
              t.e.IPhoneKbdSpace_1, r.br(), t.e.IPhoneKbdSpace_2),

            eds.isInEmbeddedEditor ? null :  // [RESEMBEDTR]
              r.div({ className: 's_Resizor-Up', ref: 'resizeHandle' }),
          )));
  }
});


const GuidelinesModal = createClassAndFactory({
  displayName: 'GuidelinesModal',

  render: function () {
    const body = !this.props.isOpen ? null :
      r.div({ className: 'dw-editor-guidelines-text',
        dangerouslySetInnerHTML: { __html: this.props.guidelines.safeHtml }});
    return (
      rb.Modal({ show: this.props.isOpen, onHide: this.props.close,
          dialogClassName: 'es-guidelines-modal' },
        rb.ModalBody({}, body),
        rb.ModalFooter({}, Button({ onClick: this.props.close }, t.Okay))));
  }
});


function page_isUsabilityTesting(pageType: PageRole): boolean {  // [plugin]
  return pageType === PageRole.UsabilityTesting;
}


function wrapSelectedText(textarea, content: string, wrap: string, wrapAfter?: string,
      newlines?: string) {
  const startIndex = textarea.selectionStart;
  const endIndex = textarea.selectionEnd;
  const selectedText = textarea.value.substring(startIndex, endIndex);
  const textBefore = textarea.value.substring(0, startIndex);
  const textAfter = textarea.value.substring(endIndex);

  if (_.isUndefined(wrapAfter)) wrapAfter = wrap;
  if (selectedText) content = selectedText;
  if (!newlines) newlines = '';

  return textBefore + newlines + wrap + content + (wrapAfter || '') + newlines + textAfter;
}


function makeDefaultReplyText(store: Store, postIds: PostId[]): string {
  const page: Page = store.currentPage;
  let result = '';
  // For UTX replies, include the instructions, in bold-italic lines,  [2JFKD0Y3]
  // so people can write their replies in between.
  if (page.pageRole === PageRole.UsabilityTesting &&  // [plugin]
      postIds.length === 1 && postIds[0] === BodyNr) {
    const origPost: Post = page.postsByNr[BodyNr];
    if (!origPost) return '';
    const elemsInclText: HTMLCollection = $h.parseHtml(origPost.sanitizedHtml);
    // Remove top level text elems (only whitespace and newlines?), and anything after any <hr>
    // — so it's possible to add background info, without including it in the actual instructions.
    let afterHr = false;
    const elems = _.filter(elemsInclText, (elem: HTMLElement) => {
      if (elem.nodeType === 3)  // text elem
        return false;
      if (elem.nodeType === 1 && elem.nodeName === 'HR')
        afterHr = true;
      return !afterHr;
    });

    // Remove "Go to: ... And answer the questions", which should be the first 2 paragraphs:
    elems.splice(0, 2);
    _.each(elems, (elem: HTMLElement) => {
      // UTX specific CSS makes these H5 titles look nice, a bit like quotes.
      // Add ##### both before each paragraph, and also before each line in the paragraphs,
      // in case there's just one paragraph with newline ('\n' = <br>) separated instructions.
      result += '##### ' + elem.innerText.replace('#', '\\#').replace(/\n+/g, '\n\n##### ') + '\n\n';
    });
    // Remove "[...", e.g. "[Edit: ...]", lines. They've been prefixed with '#####'.
    result = result.replace(/\n+##### \[[^\n]*/g, '');
    result = result.trim() + '\n';
  }
  return result;
}



// We currently don't save any draft server side, for the 1st embedded comment  [BLGCMNT1]
// on a new blog post, because the embedded page hasn't yet been created (it gets created
// lazily when the 1st reply is posted [4AMJX7]); there's no page id to use in the
// draft locator. Could use the embedding URL though, or data-discussion-id="..."
// embedding page html tag attr.
function isEmbeddedNotYetCreatedPage(props: { store: Store, messageToUserIds }): boolean {
  // If is-no-page, then the page doesn't exist. However, we might be in the user
  // profile section, composing a reply or a direct message to someone — then we
  // do save drafts.
  const result =
      !eds.embeddedPageId &&
      store_isNoPage(props.store) &&
      !props.messageToUserIds.length && // could skip this?
      eds.isInIframe;
  // @ifdef DEBUG
  dieIf(result && !eds.isInEmbeddedEditor, 'TyE7KBTF32');
  // @endif
  return result;
}

const previewHelpMessage = {
  id: 'EdH7MF24',
  version: 1,
  content:
      r.span({}, t.e.PreviewInfo,
        r.br(), t.e.CannotType)
};


export function DraftStatusInfo(props: { draftStatus: DraftStatus, draftNr: number,
       draftErrorStatusCode?: number }) {

  let draftStatusText;
  let draftErrorClass = '';
  const draftNr: number | string = props.draftNr || '';
  const draftErrorStatusCode: number | undefined = props.draftErrorStatusCode;

  switch (props.draftStatus) {
    case DraftStatus.NotLoaded: draftStatusText = t.e.LoadingDraftDots; break;
    case DraftStatus.NothingHappened: break;
    case DraftStatus.EditsUndone: draftStatusText = t.e.DraftUnchanged; break;
    case DraftStatus.SavedInBrowser: draftStatusText = t.e.DraftSavedBrwsr; break;
    case DraftStatus.SavedServerSide: draftStatusText = t.e.DraftSaved(draftNr); break;
    case DraftStatus.Deleted: draftStatusText = t.e.DraftDeleted(draftNr); break;
    case DraftStatus.ShouldSave: draftStatusText = t.e.WillSaveDraft(draftNr); break;
    case DraftStatus.SavingSmall: draftStatusText = t.e.SavingDraft(draftNr); break;
    // UX COULD show in modal dialog, and an "Ok I'll wait until you're done" button, and a Cancel button.
    case DraftStatus.SavingBig: draftStatusText = t.e.SavingDraft(draftNr); break;
    case DraftStatus.Deleting: draftStatusText = t.e.DeletingDraft(draftNr); break;
    case DraftStatus.CannotSave:
      draftErrorClass = ' s_DfSts-Err';
      let details: string;
      if (draftErrorStatusCode === 403) details = "Access denied";
      else if (draftErrorStatusCode === 429) details = "Too many requests";
      else if (draftErrorStatusCode) details = "Error " + draftErrorStatusCode;
      else details = t.ni.NoInet;
      draftStatusText = t.e.CannotSaveDraftC + ' ' + details;
      break;
  }

  return !draftStatusText ? null :
       r.span({ className: 's_DfSts e_DfSts-' + props.draftStatus + draftErrorClass }, draftStatusText);
}


//------------------------------------------------------------------------------
   }
//------------------------------------------------------------------------------
// vim: fdm=marker et ts=2 sw=2 tw=0 fo=r list
