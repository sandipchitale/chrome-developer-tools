// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @constructor
 * @extends {WebInspector.VBox}
 * @implements {WebInspector.TargetManager.Observer}
 */
WebInspector.PromisePane = function()
{
    WebInspector.VBox.call(this);
    this.registerRequiredCSS("ui/filter.css");
    this.registerRequiredCSS("promises/promisePane.css");
    this.element.classList.add("promises");

    var statusBar = new WebInspector.StatusBar(this.element);
    this._recordButton = new WebInspector.StatusBarButton("", "record-status-bar-item");
    this._recordButton.addEventListener("click", this._recordButtonClicked.bind(this));
    statusBar.appendStatusBarItem(this._recordButton);

    var clearButton = new WebInspector.StatusBarButton(WebInspector.UIString("Clear"), "clear-status-bar-item");
    clearButton.addEventListener("click", this._clearButtonClicked.bind(this));
    statusBar.appendStatusBarItem(clearButton);

    this._filterBar = new WebInspector.FilterBar();
    statusBar.appendStatusBarItem(this._filterBar.filterButton());

    var garbageCollectButton = new WebInspector.StatusBarButton(WebInspector.UIString("Collect garbage"), "garbage-collect-status-bar-item");
    garbageCollectButton.addEventListener("click", this._garbageCollectButtonClicked, this);
    statusBar.appendStatusBarItem(garbageCollectButton);

    var asyncCheckbox = new WebInspector.StatusBarCheckbox(WebInspector.UIString("Async"), WebInspector.UIString("Capture async stack traces"), WebInspector.settings.enableAsyncStackTraces);
    statusBar.appendStatusBarItem(asyncCheckbox);

    // Filter UI controls.
    this._hiddenByFilterCount = 0;
    this._filtersContainer = this.element.createChild("div", "promises-filters-header hidden");
    this._filtersContainer.appendChild(this._filterBar.filtersElement());
    this._filterBar.addEventListener(WebInspector.FilterBar.Events.FiltersToggled, this._onFiltersToggled, this);
    this._filterBar.setName("promisePane");

    var statuses = [
        { name: "pending", label: WebInspector.UIString("Pending") },
        { name: "resolved", label: WebInspector.UIString("Fulfilled") },
        { name: "rejected", label: WebInspector.UIString("Rejected") }
    ];
    this._promiseStatusFiltersSetting = WebInspector.settings.createSetting("promiseStatusFilters", {});
    this._statusFilterUI = new WebInspector.NamedBitSetFilterUI(statuses, this._promiseStatusFiltersSetting);
    this._statusFilterUI.addEventListener(WebInspector.FilterUI.Events.FilterChanged, this._filtersChanged, this);
    this._filterBar.addFilter(this._statusFilterUI);

    this._filterStatusMessageElement = this.element.createChild("div", "promises-filter-status hidden");
    this._filterStatusTextElement = this._filterStatusMessageElement.createChild("span");
    this._filterStatusMessageElement.createTextChild(" ");
    var resetFiltersLink = this._filterStatusMessageElement.createChild("span", "link");
    resetFiltersLink.textContent = WebInspector.UIString("Show all promises.");
    resetFiltersLink.addEventListener("click", this._resetFilters.bind(this), true);

    this._dataGridContainer = new WebInspector.VBox();
    this._dataGridContainer.show(this.element);
    // FIXME: Make "status" column width fixed to ~16px.
    var columns = [
        { id: "status", weight: 1 },
        { id: "function", title: WebInspector.UIString("Function"), disclosure: true, weight: 10 },
        { id: "created", title: WebInspector.UIString("Created"), weight: 10 },
        { id: "settled", title: WebInspector.UIString("Settled"), weight: 10 },
        { id: "tts", title: WebInspector.UIString("Time to settle"), weight: 10 }
    ];
    this._dataGrid = new WebInspector.DataGrid(columns, undefined, undefined, undefined, this._onContextMenu.bind(this));
    this._dataGrid.show(this._dataGridContainer.element);

    this._linkifier = new WebInspector.Linkifier();

    /** @type {!Map.<!WebInspector.Target, !Map.<number, !DebuggerAgent.PromiseDetails>>} */
    this._promiseDetailsByTarget = new Map();
    /** @type {!Map.<number, !WebInspector.DataGridNode>} */
    this._promiseIdToNode = new Map();

    this._popoverHelper = new WebInspector.PopoverHelper(this.element, this._getPopoverAnchor.bind(this), this._showPopover.bind(this));
    this._popoverHelper.setTimeout(250, 250);

    this.element.addEventListener("click", this._hidePopover.bind(this), true);

    WebInspector.targetManager.addModelListener(WebInspector.DebuggerModel, WebInspector.DebuggerModel.Events.PromiseUpdated, this._onPromiseUpdated, this);
    WebInspector.targetManager.addModelListener(WebInspector.ResourceTreeModel, WebInspector.ResourceTreeModel.EventTypes.MainFrameNavigated, this._mainFrameNavigated, this);
    WebInspector.context.addFlavorChangeListener(WebInspector.Target, this._targetChanged, this);

    WebInspector.targetManager.observeTargets(this);
}

WebInspector.PromisePane.prototype = {
    /**
     * @override
     * @return {!Array.<!Element>}
     */
    elementsToRestoreScrollPositionsFor: function()
    {
        return [this._dataGrid.scrollContainer];
    },

    /**
     * @override
     * @param {!WebInspector.Target} target
     */
    targetAdded: function(target)
    {
        if (this._enabled)
            this._enablePromiseTracker(target);
    },

    /**
     * @override
     * @param {!WebInspector.Target} target
     */
    targetRemoved: function(target)
    {
        this._promiseDetailsByTarget.delete(target);
        if (this._target === target) {
            this._clear();
            delete this._target;
        }
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _targetChanged: function(event)
    {
        if (!this._enabled)
            return;
        var target = /** @type {!WebInspector.Target} */ (event.data);
        if (this._target === target)
            return;
        this._target = target;
        this._refresh();
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _mainFrameNavigated: function(event)
    {
        var frame = /** @type {!WebInspector.ResourceTreeFrame} */ (event.data);
        var target = frame.target();
        this._promiseDetailsByTarget.delete(target);
        if (this._target === target)
            this._clear();
    },

    /** @override */
    wasShown: function()
    {
        // Auto enable upon the very first show.
        if (typeof this._enabled === "undefined") {
            this._target = WebInspector.context.flavor(WebInspector.Target);
            this._updateRecordingState(true);
        }
    },

    /**
     * @param {!WebInspector.Target} target
     */
    _enablePromiseTracker: function(target)
    {
        target.debuggerAgent().enablePromiseTracker(true);
    },

    /**
     * @param {!WebInspector.Target} target
     */
    _disablePromiseTracker: function(target)
    {
        target.debuggerAgent().disablePromiseTracker();
    },

    /** @override */
    willHide: function()
    {
        this._hidePopover();
    },

    _hidePopover: function()
    {
        this._popoverHelper.hidePopover();
    },

    _recordButtonClicked: function()
    {
        this._updateRecordingState(!this._recordButton.toggled());
    },

    /**
     * @param {boolean} enabled
     */
    _updateRecordingState: function(enabled)
    {
        this._enabled = enabled;
        this._recordButton.setToggled(this._enabled);
        this._recordButton.setTitle(this._enabled ? WebInspector.UIString("Stop Recording Promises Log") : WebInspector.UIString("Record Promises Log"));
        WebInspector.targetManager.targets().forEach(this._enabled ? this._enablePromiseTracker : this._disablePromiseTracker, this);
    },

    _clearButtonClicked: function()
    {
        this._clear();
        if (this._target)
            this._promiseDetailsByTarget.delete(this._target);
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _onFiltersToggled: function(event)
    {
        var toggled = /** @type {boolean} */ (event.data);
        this._filtersContainer.classList.toggle("hidden", !toggled);
    },

    _filtersChanged: function()
    {
        this._refresh();
    },

    _resetFilters: function()
    {
        this._promiseStatusFiltersSetting.set({});
    },

    _updateFilterStatus: function()
    {
        this._filterStatusTextElement.textContent = WebInspector.UIString(this._hiddenByFilterCount === 1 ? "%d promise is hidden by filters." : "%d promises are hidden by filters.", this._hiddenByFilterCount);
        this._filterStatusMessageElement.classList.toggle("hidden", !this._hiddenByFilterCount);
    },

    _garbageCollectButtonClicked: function()
    {
        var targets = WebInspector.targetManager.targets();
        for (var i = 0; i < targets.length; ++i)
            targets[i].heapProfilerAgent().collectGarbage();
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _onPromiseUpdated: function(event)
    {
        var target = /** @type {!WebInspector.Target} */ (event.data.target);
        var eventType = /** @type {string} */ (event.data.eventType);
        var details = /** @type {!DebuggerAgent.PromiseDetails} */ (event.data.promise);
        if (eventType === "gc")
            details.__isGarbageCollected = true;

        var promiseIdToDetails = this._promiseDetailsByTarget.get(target);
        if (!promiseIdToDetails) {
            promiseIdToDetails = new Map();
            this._promiseDetailsByTarget.set(target, promiseIdToDetails)
        }
        var previousDetails = promiseIdToDetails.get(details.id);
        promiseIdToDetails.set(details.id, details);

        if (target === this._target)
            this._attachDataGridNode(details);

        var wasVisible = !previousDetails || this._statusFilterUI.accept(previousDetails.status);
        var isVisible = this._statusFilterUI.accept(details.status);
        if (wasVisible !== isVisible) {
            this._hiddenByFilterCount += wasVisible ? 1 : -1;
            this._updateFilterStatus();
        }
    },

    /**
     * @param {!DebuggerAgent.PromiseDetails} details
     */
    _attachDataGridNode: function(details)
    {
        var scrolledToBottom = this._dataGrid.scrollContainer.isScrolledToBottom();
        var node = this._createDataGridNode(details);
        var parentNode = this._findVisibleParentNodeDetails(details);
        if (parentNode !== node.parent)
            parentNode.appendChild(node);
        if (details.__isGarbageCollected)
            node.element().classList.add("promise-gc");
        if (this._statusFilterUI.accept(details.status))
            parentNode.expanded = true;
        else
            node.remove();
        if (scrolledToBottom)
            this._dataGrid.scrollContainer.scrollTop = this._dataGrid.scrollContainer.scrollHeight;
    },

    /**
     * @param {!DebuggerAgent.PromiseDetails} details
     * @return {!WebInspector.DataGridNode}
     */
    _findVisibleParentNodeDetails: function(details)
    {
        var promiseIdToDetails = this._promiseDetailsByTarget.get(this._target);
        while (details) {
            var parentId = details.parentId;
            if (typeof parentId !== "number")
                break;
            details = promiseIdToDetails.get(parentId);
            if (!details)
                break;
            if (!this._statusFilterUI.accept(details.status))
                continue;
            var node = this._promiseIdToNode.get(details.id);
            if (node)
                return node;
        }
        return this._dataGrid.rootNode();
    },

    /**
     * @param {!DebuggerAgent.PromiseDetails} details
     * @return {!WebInspector.DataGridNode}
     */
    _createDataGridNode: function(details)
    {
        var title = "";
        switch (details.status) {
        case "pending":
            title = WebInspector.UIString("Pending");
            break;
        case "resolved":
            title = WebInspector.UIString("Fulfilled");
            break;
        case "rejected":
            title = WebInspector.UIString("Rejected");
            break;
        }
        if (details.__isGarbageCollected)
            title += " " + WebInspector.UIString("(garbage collected)");

        var statusElement = createElementWithClass("div", "status " + details.status);
        statusElement.title = title;
        var data = {
            status: statusElement,
            promiseId: details.id,
            function: WebInspector.beautifyFunctionName(details.callFrame ? details.callFrame.functionName : "")
        };
        if (details.callFrame)
            data.created = this._linkifier.linkifyConsoleCallFrame(this._target, details.callFrame);
        if (details.settlementStack && details.settlementStack[0])
            data.settled = this._linkifier.linkifyConsoleCallFrame(this._target, details.settlementStack[0]);
        if (details.creationTime && details.settlementTime && details.settlementTime >= details.creationTime)
            data.tts = Number.millisToString(details.settlementTime - details.creationTime);
        var node = this._promiseIdToNode.get(details.id);
        if (!node) {
            node = new WebInspector.DataGridNode(data, false);
            this._promiseIdToNode.set(details.id, node);
        } else {
            node.data = data;
        }
        return node;
    },

    _refresh: function()
    {
        this._clear();
        if (!this._target)
            return;
        if (!this._promiseDetailsByTarget.has(this._target))
            return;

        var rootNode = this._dataGrid.rootNode();
        var promiseIdToDetails = this._promiseDetailsByTarget.get(this._target);

        var nodesToInsert = { __proto__: null };
        // The for..of loop iterates in insertion order.
        for (var pair of promiseIdToDetails) {
            var id = /** @type {number} */ (pair[0]);
            var details = /** @type {!DebuggerAgent.PromiseDetails} */ (pair[1]);
            if (!this._statusFilterUI.accept(details.status)) {
                ++this._hiddenByFilterCount;
                continue;
            }
            nodesToInsert[id] = { details: details, node: this._createDataGridNode(details) };
        }

        for (var id in nodesToInsert) {
            var node = nodesToInsert[id].node;
            var details = nodesToInsert[id].details;
            this._findVisibleParentNodeDetails(details).appendChild(node);
        }

        for (var id in nodesToInsert) {
            var node = nodesToInsert[id].node;
            var details = nodesToInsert[id].details;
            node.expanded = true;
            if (details.__isGarbageCollected)
                node.element().classList.add("promise-gc");
        }

        this._updateFilterStatus();
    },

    _clear: function()
    {
        this._hiddenByFilterCount = 0;
        this._promiseIdToNode.clear();
        this._hidePopover();
        this._dataGrid.rootNode().removeChildren();
        this._linkifier.reset();
    },

    /**
     * @param {!WebInspector.ContextMenu} contextMenu
     * @param {!WebInspector.DataGridNode} node
     */
    _onContextMenu: function(contextMenu, node)
    {
        var target = this._target;
        if (!target)
            return;

        var promiseId = node.data.promiseId;
        if (this._promiseDetailsByTarget.has(target)) {
            var details = this._promiseDetailsByTarget.get(target).get(promiseId);
            if (details.__isGarbageCollected)
                return;
        }

        contextMenu.appendItem(WebInspector.UIString.capitalize("Show in ^console"), showPromiseInConsole);
        contextMenu.show();

        function showPromiseInConsole()
        {
            target.debuggerAgent().getPromiseById(promiseId, "console", didGetPromiseById);
        }

        /**
         * @param {?Protocol.Error} error
         * @param {?RuntimeAgent.RemoteObject} promise
         */
        function didGetPromiseById(error, promise)
        {
            if (error || !promise)
                return;

            target.consoleAgent().setLastEvaluationResult(promise.objectId);
            var message = new WebInspector.ConsoleMessage(target,
                                                          WebInspector.ConsoleMessage.MessageSource.Other,
                                                          WebInspector.ConsoleMessage.MessageLevel.Log,
                                                          "",
                                                          WebInspector.ConsoleMessage.MessageType.Log,
                                                          undefined,
                                                          undefined,
                                                          undefined,
                                                          undefined,
                                                          [promise]);
            target.consoleModel.addMessage(message);
            WebInspector.console.show();
        }
    },

    /**
     * @param {!Element} element
     * @param {!Event} event
     * @return {!Element|!AnchorBox|undefined}
     */
    _getPopoverAnchor: function(element, event)
    {
        if (!this._target || !this._promiseDetailsByTarget.has(this._target))
            return undefined;
        var node = this._dataGrid.dataGridNodeFromNode(element);
        if (!node)
            return undefined;
        var details = this._promiseDetailsByTarget.get(this._target).get(node.data.promiseId);
        if (!details)
            return undefined;
        var anchor = element.enclosingNodeOrSelfWithClass("created-column");
        if (anchor)
            return details.creationStack ? anchor : undefined;
        anchor = element.enclosingNodeOrSelfWithClass("settled-column");
        return (anchor && details.settlementStack) ? anchor : undefined;
    },

    /**
     * @param {!Element} anchor
     * @param {!WebInspector.Popover} popover
     */
    _showPopover: function(anchor, popover)
    {
        var node = this._dataGrid.dataGridNodeFromNode(anchor);
        var details = this._promiseDetailsByTarget.get(this._target).get(node.data.promiseId);

        var stackTrace;
        var asyncStackTrace;
        if (anchor.classList.contains("created-column")) {
            stackTrace = details.creationStack;
            asyncStackTrace = details.asyncCreationStack;
        } else {
            stackTrace = details.settlementStack;
            asyncStackTrace = details.asyncSettlementStack;
        }

        var content = WebInspector.DOMPresentationUtils.buildStackTracePreviewContents(this._target, this._linkifier, stackTrace, asyncStackTrace);
        popover.setCanShrink(true);
        popover.showForAnchor(content, anchor);
    },

    __proto__: WebInspector.VBox.prototype
}
