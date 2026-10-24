/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    'N/search',
    'N/record',
    'N/runtime',
    'N/url',
    'N/redirect',
    'N/log'
], (
    serverWidget,
    search,
    record,
    runtime,
    url,
    redirect,
    log
) => {

    /*
     * Config describing each transaction type this Suitelet
     * handles. Field semantics:
     * - custrecord_pac_record_type: 2 = Vendor Bill, 1 = Purchase Order
     * - The same body fields (custbody_demo_current_approval_done,
     *   custbody_demo_approval_reject_reason, approvalstatus,
     *   nextapprover, custbody_demo_approval_current_level,
     *   custbody_demo_last_approval_level) exist on both record types.
     */
    const getTransactionTypes = () => [
        {
            key: 'bill',
            sublistId: 'custpage_bill_list',
            sublistLabel: 'Vendor Bills',
            recordType: record.Type.VENDOR_BILL,
            searchType: search.Type.VENDOR_BILL,
            recordTypeFilterValue: '2',
            linkFieldId: 'custpage_reclink',
            linkLabel: 'View Bill',
            numberFieldId: 'custpage_recnumber',
            numberLabel: 'Bill Number',
            showNumberColumn: true,
            referenceLabel: 'Reference Number',
            entityLabel: 'Vendor Bill',
            noRecordsText:
                'No Vendor Bills are currently pending your approval.'
        },
        {
            key: 'po',
            sublistId: 'custpage_po_list',
            sublistLabel: 'Purchase Orders',
            recordType: record.Type.PURCHASE_ORDER,
            searchType: search.Type.PURCHASE_ORDER,
            recordTypeFilterValue: '1',
            linkFieldId: 'custpage_reclink',
            linkLabel: 'View PO',
            numberFieldId: 'custpage_recnumber',
            numberLabel: 'PO Number',
            showNumberColumn: false,
            referenceLabel: 'PO Number',
            entityLabel: 'Purchase Order',
            noRecordsText:
                'No Purchase Orders are currently pending your approval.'
        }
    ];

    /*
     * approvalstatus list values (see Field Help on the
     * Vendor Bill "Approval Status" field):
     * 1 = Pending Approval, 2 = Approved, 3 = Rejected
     */
    const APPROVAL_STATUS_REJECTED = '3';
    const APPROVAL_STATUS_PENDING = '1';

    /*
     * Approval Instance record fields for closing out the
     * CURRENT level being rejected.
     *
     * ASSUMPTION - please confirm/correct:
     * - custrecord_pai_approval_status is assumed to share the same
     *   list values as the Vendor Bill's approvalstatus field
     *   (1 = Pending, 2 = Approved, 3 = Rejected), since the code
     *   already filters on '1' for Pending elsewhere in this file.
     * - The exact field ID for "Approval Completed Date" is a
     *   best guess based on the custrecord_pai_ naming convention
     *   already used on this record (approver, delegate, comment,
     *   approval_status, po). If this isn't the real internal ID,
     *   the submitFields call below will throw an error you'll see
     *   in the log - swap in the correct ID from the field's
     *   "Customize" / Field Help panel.
     */
    const INSTANCE_STATUS_REJECTED = APPROVAL_STATUS_REJECTED;
    const INSTANCE_COMPLETED_DATE_FIELD =
        'custrecord_pai_approval_completed_date';

    /*
     * Confirmed from Email_Plugin_For_Vendor_Bill.js, which handles
     * the email-reply approval path for the SAME workflow:
     *
     *   custbody_demo_current_approval_done: 1 = Approve, 2 = Reject
     *   custrecord_pai_channel_used: 1 = UI Button, 2 = Email Reply
     *
     * Setting custbody_demo_current_approval_done fires
     * Approval_Level_Update_WFA (bound to the "Approval Pending"
     * state's ONENTRY event), which does the real work: sets
     * approvalstatus, clears the level/nextapprover fields, and -
     * because it runs as part of the workflow itself - actually
     * transitions the SuiteFlow instance's state, which is what
     * makes the record's Approve/Reject/Re-Submit buttons update
     * correctly. It then clears the field itself to prevent
     * re-looping. This Suitelet should never set approvalstatus,
     * custbody_demo_approval_current_level, custbody_demo_last_approval_level,
     * or nextapprover directly - that bypasses the workflow and is
     * why the buttons weren't updating.
     */
    const REJECT_DONE_VALUE = '2';
    const CHANNEL_UI_BUTTON = '1';

    /**
     * Suitelet entry point
     */
    const onRequest = (context) => {
        try {
            if (context.request.method === 'GET') {
                renderApprovalPage(context);
            } else {
                const action =
                    context.request.parameters.custpage_action ||
                    'approve';

                if (action === 'reject') {
                    processRejections(context);
                } else {
                    processApprovals(context);
                }
            }
        } catch (error) {
            log.error({
                title: 'Bulk Approval Suitelet Error',
                details: error
            });

            throw error;
        }
    };

    /**
     * Render Vendor Bill approval page
     */
    const renderApprovalPage = (context) => {
        const form = serverWidget.createForm({
            title: 'Transactions Pending My Approval'
        });

        const currentUserId = runtime.getCurrentUser().id;

        log.debug({
            title: 'Bulk Approval - Current User',
            details: currentUserId
        });

        /*
         * Hidden field telling the server which action the user
         * triggered ('approve' or 'reject'). Defaults to 'approve'
         * as a safe fallback.
         */
        const actionField = form.addField({
            id: 'custpage_action',
            type: serverWidget.FieldType.TEXT,
            label: 'Action'
        });

        actionField.updateDisplayType({
            displayType: serverWidget.FieldDisplayType.HIDDEN
        });

        actionField.defaultValue = 'approve';

        /*
         * A real, native submit button is required: for a LIST-type
         * sublist, NetSuite keeps line data (checkboxes, comments) in
         * a client-side model that is only flushed into the actual
         * POST body when NetSuite's OWN submit control is triggered.
         * A plain <input type="button"> calling form.submit()
         * directly skips that step and posts stale/empty sublist
         * data. So this native button is kept, but hidden via CSS -
         * our custom Approve/Reject buttons below click it
         * programmatically after setting custpage_action.
         */
        form.addSubmitButton({
            label: 'DEMO_INTERNAL_SUBMIT'
        });

        /*
         * Everything visible at the top of the page - the redirect
         * status cards, the Approve/Reject buttons, and (once known)
         * the no-records card - is built as plain HTML strings and
         * concatenated into ONE single field below, instead of each
         * being its own field. Relying on separate fields plus
         * updateBreakType(STARTROW) to keep them stacked kept
         * breaking: NetSuite's two-column form layout repeatedly
         * paired unrelated fields onto the same visual row regardless
         * of the break-type hint. One field with plain block-level
         * HTML inside it stacks correctly by ordinary document flow,
         * with no dependency on NetSuite's column-packing behavior.
         */
        const statusHtml = buildStatusMessageHtml(
            context.request.parameters
        );

        const buttonsHtml = buildButtonsHtml();

        const processedParam = context.request.parameters.processed;
        const resultsByType = {};
        let totalResults = 0;

        getTransactionTypes().forEach((config) => {
            const results = getPendingApprovals(
                currentUserId,
                config,
                processedParam
            );

            log.debug({
                title: config.sublistLabel + ' Found',
                details: results.length
            });

            /*
             * LIST prevents users from adding their own lines.
             */
            const sublist = form.addSublist({
                id: config.sublistId,
                type: serverWidget.SublistType.LIST,
                label:
                    config.sublistLabel +
                    ' (' + results.length + ')'
            });

            /*
             * NetSuite-native Mark All and Unmark All buttons.
             */
            sublist.addMarkAllButtons();

            addSublistFields(sublist, config);

            populateSublist(sublist, results, config);

            resultsByType[config.key] = results;
            totalResults += results.length;
        });

        const noRecordsHtml =
            totalResults === 0 ? buildNoRecordsHtml() : '';

        const topField = form.addField({
            id: 'custpage_top_messages',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });

        topField.updateBreakType({
            breakType: serverWidget.FieldBreakType.STARTROW
        });

        topField.defaultValue =
            buttonsHtml + statusHtml + noRecordsHtml;

        context.response.writePage(form);
    };

    /**
     * Build the redirect-driven result message (success/rejected/
     * skipped/errors) as an HTML string. Returns '' when there is
     * nothing to show.
     */
    const buildStatusMessageHtml = (parameters) => {
        const successCount = parseInt(parameters.success || '0', 10);
        const rejectedCount = parseInt(parameters.rejected || '0', 10);
        const skippedCount = parseInt(parameters.skipped || '0', 10);
        const errors = parameters.errors || '';

        if (!successCount && !rejectedCount && !skippedCount && !errors) {
            return '';
        }

        /*
         * One color-coded card per outcome, each with an icon and a
         * left accent border, instead of stacking plain colored text
         * lines inside a single flat gray box.
         */
        const buildCard = (badgeChar, bg, border, textColor, message) =>
            '<div style="' +
            'display:flex;' +
            'align-items:flex-start;' +
            'gap:10px;' +
            'padding:12px 16px;' +
            'margin-bottom:8px;' +
            'background:' + bg + ';' +
            'border:1px solid ' + border + ';' +
            'border-left:4px solid ' + border + ';' +
            'border-radius:6px;' +
            'font-family:Arial,Helvetica,sans-serif;' +
            '">' +
            '<span style="' +
            'flex:0 0 auto;' +
            'width:18px; height:18px;' +
            'margin-top:1px;' +
            'border-radius:50%;' +
            'background:' + border + ';' +
            'color:#ffffff;' +
            'font-size:12px;' +
            'font-weight:bold;' +
            'line-height:18px;' +
            'text-align:center;' +
            '">' +
            badgeChar +
            '</span>' +
            '<span style="color:' + textColor + ';' +
            'font-size:13px;line-height:1.4;">' +
            message +
            '</span>' +
            '</div>';

        let html = '<div style="margin-bottom:6px;">';

        if (successCount > 0) {
            html += buildCard(
                '&#10003;',
                '#eef7ee',
                '#3f9142',
                '#2b5e2d',
                '<b>' +
                    escapeHtml(String(successCount)) +
                    '</b> record(s) submitted for approval.'
            );
        }

        if (rejectedCount > 0) {
            html += buildCard(
                '&#10005;',
                '#fdecec',
                '#c0392b',
                '#8a231a',
                '<b>' +
                    escapeHtml(String(rejectedCount)) +
                    '</b> record(s) rejected.'
            );
        }

        if (skippedCount > 0) {
            html += buildCard(
                '!',
                '#fff6e5',
                '#c98a1e',
                '#7a5210',
                '<b>' +
                    escapeHtml(String(skippedCount)) +
                    '</b> record(s) were skipped.'
            );
        }

        if (errors) {
            const errorItems = errors
                .split(' | ')
                .filter((item) => item.trim())
                .map(
                    (item, index) =>
                        '<div style="' +
                        (index > 0 ? 'margin-top:4px;' : '') +
                        '">' +
                        escapeHtml(item) +
                        '</div>'
                )
                .join('');

            html += buildCard(
                '!',
                '#fdecec',
                '#c0392b',
                '#8a231a',
                errorItems
            );
        }

        html += '</div>';

        /*
         * These params live in the URL because that's how a redirect
         * hands the result back to a fresh GET. Left in place, simply
         * reloading or reopening this exact URL later resends the
         * same stale message indefinitely. Strip them from the
         * address bar once shown, without touching script/deploy or
         * any other params, so a later reload starts clean.
         */
        html +=
            '<script>' +
            '(function () {' +
            'try {' +
            'var ndUrl = new URL(window.location.href);' +
            '[\'success\', \'rejected\', \'skipped\', ' +
            '\'errors\', \'processed\'].forEach(function (p) {' +
            'ndUrl.searchParams.delete(p);' +
            '});' +
            'window.history.replaceState(' +
            'null, \'\', ndUrl.toString()' +
            ');' +
            '} catch (e) {}' +
            '})();' +
            '<' + '/script>';

        return html;
    };

    /**
     * Build the Approve/Reject buttons, loader overlay, and their
     * driving JS as an HTML string.
     */
    const buildButtonsHtml = () =>
            '<style>' +
            'input[value="DEMO_INTERNAL_SUBMIT"] { ' +
            'display:none !important; }' +
            '@keyframes demoSpin { ' +
            'from { transform:rotate(0deg); } ' +
            'to { transform:rotate(360deg); } }' +
            '#demo_bulk_loader_overlay {' +
            'display:none;' +
            'position:fixed;' +
            'top:0; left:0; right:0; bottom:0;' +
            'background:rgba(255,255,255,0.75);' +
            'z-index:9999;' +
            'text-align:center;' +
            'padding-top:120px;' +
            'font-family:Arial,Helvetica,sans-serif;' +
            '}' +
            '#demo_bulk_loader_overlay .nd-spinner {' +
            'width:42px; height:42px;' +
            'margin:0 auto 14px auto;' +
            'border:4px solid #cfe1f5;' +
            'border-top:4px solid #1c76c6;' +
            'border-radius:50%;' +
            'animation:demoSpin 0.8s linear infinite;' +
            '}' +
            '#demo_bulk_loader_overlay .nd-loader-text {' +
            'color:#1c76c6;' +
            'font-size:13px;' +
            'font-weight:bold;' +
            '}' +
            '</style>' +
            '<div id="demo_bulk_loader_overlay">' +
            '<div class="nd-spinner"></div>' +
            '<div class="nd-loader-text">Processing, please wait...</div>' +
            '</div>' +
            '<div style="margin:10px 0 15px 0;">' +
            '<input type="button" ' +
            'value="Approve Selected" ' +
            'onclick="ndBulkApprovalSubmit(\'approve\');" ' +
            'style="' +
            'background:linear-gradient(to bottom,#6fb1e8,#1c76c6);' +
            'color:#ffffff;' +
            'font-family:Arial,Helvetica,sans-serif;' +
            'font-size:11px;' +
            'font-weight:bold;' +
            'padding:5px 16px;' +
            'border:1px solid #1a5a94;' +
            'border-radius:3px;' +
            'cursor:pointer;' +
            'margin-right:8px;" />' +
            '<input type="button" ' +
            'value="Reject Selected" ' +
            'onclick="ndBulkApprovalSubmit(\'reject\');" ' +
            'style="' +
            'background:linear-gradient(to bottom,#6fb1e8,#1c76c6);' +
            'color:#ffffff;' +
            'font-family:Arial,Helvetica,sans-serif;' +
            'font-size:11px;' +
            'font-weight:bold;' +
            'padding:5px 16px;' +
            'border:1px solid #1a5a94;' +
            'border-radius:3px;' +
            'cursor:pointer;" />' +
            '</div>' +
            '<script>' +
            'function ndBulkApprovalSubmit(action) {' +
            'require([\'N/currentRecord\'], function (currentRecord) {' +
            'var rec = currentRecord.get();' +
            'if (action === \'reject\' && ' +
            '!ndValidateRejectComments(rec)) {' +
            'return;' +
            '}' +
            'rec.setValue({' +
            'fieldId: \'custpage_action\',' +
            'value: action,' +
            'ignoreFieldChange: true' +
            '});' +
            'var frm = document.forms[\'main_form\'] || ' +
            'document.forms[0];' +
            'if (!frm) { return; }' +
            'ndShowLoader();' +
            'var nativeSubmit = frm.querySelector(' +
            '\'input[type="submit"]\');' +
            'if (nativeSubmit) {' +
            'nativeSubmit.click();' +
            '} else {' +
            'frm.submit();' +
            '}' +
            '});' +
            '}' +
            'function ndShowLoader() {' +
            'var overlay = document.getElementById(' +
            '\'demo_bulk_loader_overlay\');' +
            'if (overlay) { overlay.style.display = \'block\'; }' +
            '}' +
            'function ndValidateRejectComments(rec) {' +
            'var sublists = [' +
            '{ id: \'custpage_bill_list\', label: \'Vendor Bill\' },' +
            '{ id: \'custpage_po_list\', label: \'Purchase Order\' }' +
            '];' +
            'var missing = [];' +
            'sublists.forEach(function (s) {' +
            'var lineCount = rec.getLineCount({' +
            'sublistId: s.id' +
            '});' +
            'for (var i = 0; i < lineCount; i++) {' +
            'var selected = rec.getSublistValue({' +
            'sublistId: s.id,' +
            'fieldId: \'custpage_select\',' +
            'line: i' +
            '});' +
            'if (selected !== true && selected !== \'T\') {' +
            'continue;' +
            '}' +
            'var comment = rec.getSublistValue({' +
            'sublistId: s.id,' +
            'fieldId: \'custpage_comment\',' +
            'line: i' +
            '});' +
            'if (!comment || !String(comment).trim()) {' +
            'missing.push(s.label + \' line \' + (i + 1));' +
            '}' +
            '}' +
            '});' +
            'if (missing.length > 0) {' +
            'alert(\'A comment is required to reject a record.\\n\' +' +
            '\'Please add a comment for: \' + ' +
            'missing.join(\', \'));' +
            'return false;' +
            '}' +
            'return true;' +
            '}' +
            '<' + '/script>';

    /**
     * Build the "all caught up" no-records message as an HTML
     * string.
     */
    const buildNoRecordsHtml = () =>
                '<div style="' +
                'display:flex;' +
                'align-items:center;' +
                'gap:12px;' +
                'padding:16px 18px;' +
                'margin-top:12px;' +
                'background:#eef7ee;' +
                'border:1px solid #bfe3bf;' +
                'border-left:4px solid #3f9142;' +
                'border-radius:6px;' +
                'font-family:Arial,Helvetica,sans-serif;' +
                '">' +
                '<span style="' +
                'flex:0 0 auto;' +
                'width:24px; height:24px;' +
                'border-radius:50%;' +
                'background:#3f9142;' +
                'color:#ffffff;' +
                'font-size:14px;' +
                'font-weight:bold;' +
                'line-height:24px;' +
                'text-align:center;' +
                '">' +
                '&#10003;' +
                '</span>' +
                '<span style="color:#2b5e2d;font-size:13px;">' +
                '<b>All caught up!</b> ' +
                'No Vendor Bills or Purchase Orders are currently ' +
                'pending your approval.' +
                '</span>' +
                '</div>';

    /**
     * Add fields to the LIST sublist
     */
    const addSublistFields = (sublist, config) => {
        /*
         * Line number
         */
        sublist.addField({
            id: 'custpage_linenum',
            type: serverWidget.FieldType.TEXT,
            label: '#'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Select checkbox
         */
        sublist.addField({
            id: 'custpage_select',
            type: serverWidget.FieldType.CHECKBOX,
            label: 'Select'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.ENTRY
        });

        /*
         * Hidden internal ID
         */
        sublist.addField({
            id: 'custpage_internalid',
            type: serverWidget.FieldType.TEXT,
            label: 'Internal ID'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.HIDDEN
        });

        /*
         * Clickable record link
         */
        const recLinkField = sublist.addField({
            id: config.linkFieldId,
            type: serverWidget.FieldType.URL,
            label: config.linkLabel
        });

        recLinkField.linkText = config.linkLabel;

        if (config.showNumberColumn) {
            sublist.addField({
                id: config.numberFieldId,
                type: serverWidget.FieldType.TEXT,
                label: config.numberLabel
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });
        }

        /*
         * Reference number (labeled "PO Number" for Purchase Orders,
         * per config)
         */
        sublist.addField({
            id: 'custpage_reference',
            type: serverWidget.FieldType.TEXT,
            label: config.referenceLabel
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Vendor
         */
        sublist.addField({
            id: 'custpage_vendor',
            type: serverWidget.FieldType.TEXT,
            label: 'Vendor'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Requestor (transaction creator)
         */
        sublist.addField({
            id: 'custpage_requestor',
            type: serverWidget.FieldType.TEXT,
            label: 'Requestor'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Transaction Amount (in the transaction's own currency -
         * fxamount, not base-currency-converted)
         */
        sublist.addField({
            id: 'custpage_amount',
            type: serverWidget.FieldType.CURRENCY,
            label: 'Transaction Amount'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Currency
         */
        sublist.addField({
            id: 'custpage_currency',
            type: serverWidget.FieldType.TEXT,
            label: 'Currency'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Subsidiary
         */
        sublist.addField({
            id: 'custpage_subsidiary',
            type: serverWidget.FieldType.TEXT,
            label: 'Subsidiary'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Bill date
         */
        sublist.addField({
            id: 'custpage_date',
            type: serverWidget.FieldType.DATE,
            label: 'Date'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Delay - whole days since the current approval level was
         * requested
         */
        sublist.addField({
            id: 'custpage_delay',
            type: serverWidget.FieldType.TEXT,
            label: 'Delay (Days)'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.INLINE
        });

        /*
         * Editable approver comment
         *
         * The sublist remains LIST type, but this field is editable.
         */
        sublist.addField({
            id: 'custpage_comment',
            type: serverWidget.FieldType.TEXTAREA,
            label: 'Approver Comment'
        }).updateDisplayType({
            displayType: serverWidget.FieldDisplayType.ENTRY
        });
    };

    /**
     * Populate the approval sublist
     */
    const populateSublist = (sublist, results, config) => {
        results.forEach((row, line) => {
            setSublistValue(
                sublist,
                'custpage_linenum',
                line,
                String(line + 1)
            );

            setSublistValue(
                sublist,
                'custpage_internalid',
                line,
                row.billId
            );

            /*
             * Generate the record's view URL
             */
            const recordUrl = url.resolveRecord({
                recordType: config.recordType,
                recordId: row.billId,
                isEditMode: false
            });

            /*
             * A URL sublist field uses linkText for the displayed text.
             */
            setSublistValue(
                sublist,
                config.linkFieldId,
                line,
                recordUrl
            );

            if (config.showNumberColumn) {
                setSublistValue(
                    sublist,
                    config.numberFieldId,
                    line,
                    row.billnumber
                );
            }

            setSublistValue(
                sublist,
                'custpage_reference',
                line,
                row.referenceNumber
            );

            setSublistValue(
                sublist,
                'custpage_vendor',
                line,
                row.vendor
            );

            setSublistValue(
                sublist,
                'custpage_requestor',
                line,
                row.requestor
            );

            setSublistValue(
                sublist,
                'custpage_amount',
                line,
                row.amount
            );

            setSublistValue(
                sublist,
                'custpage_currency',
                line,
                row.currency
            );

            setSublistValue(
                sublist,
                'custpage_subsidiary',
                line,
                row.subsidiary
            );

            setSublistValue(
                sublist,
                'custpage_date',
                line,
                row.billDate
            );

            setSublistValue(
                sublist,
                'custpage_delay',
                line,
                row.delayDays
            );

            setSublistValue(
                sublist,
                'custpage_comment',
                line,
                row.comment
            );
        });
    };

    /**
     * Set a sublist value only when a value exists
     */
    const setSublistValue = (sublist, fieldId, line, value) => {
        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            return;
        }

        sublist.setSublistValue({
            id: fieldId,
            line: line,
            value: String(value)
        });
    };

    /**
     * Search pending Vendor Bill approval instances
     */
    const getPendingApprovals = (
        currentUserId,
        config,
        justProcessedParam
    ) => {
        const results = [];
        const seenBills = {};

        /*
         * Belt-and-suspenders against any lag between our
         * submitFields() calls and the workflow finishing its own
         * field updates (approvalstatus, instance status, etc.):
         * whatever record IDs were just approved/rejected are passed
         * back through the redirect and excluded here outright, so
         * they can never reappear on the very next load regardless
         * of whether the fresh search has caught up yet.
         */
        const justProcessed = {};

        (justProcessedParam || '')
            .split(',')
            .forEach((id) => {
                const trimmedId = id.trim();

                if (trimmedId) {
                    justProcessed[trimmedId] = true;
                }
            });

        const approvalSearch = search.create({
            type: 'customrecord_demo_approval_instance',
            filters: [

                  [
    [
        'custrecord_pai_delegate',
        'anyof',
        currentUserId
    ],

    'OR',

    [
        [
            'custrecord_pai_approver',
            'anyof',
            currentUserId
        ],
        'AND',
        [
            'custrecord_pai_delegate',
            'anyof',
            '@NONE@'
        ]
    ]

                 ],
                'AND',
                [
                    'custrecord_pai_approval_status',
                    'anyof',
                    '1'
                ],
                'AND',
                [
                    'custrecord_demo_pia_historical',
                    'is',
                    'F'
                ],
                'AND',
                [
                    'custrecord_demo_main_po_approval_conf.' +
                    'custrecord_pac_record_type',
                    'anyof',
                    config.recordTypeFilterValue
                ],
                'AND',
                [
                    'custrecord_pai_po.nextapprover',
                    'anyof',
                    currentUserId
                ],
                'AND',
                [
                    'custrecord_pai_po.datecreated',
                    'onorafter',
                    '06/15/2026 12:00 am'
                ],
                /*
                 * Confirmed field ID:
                 * custrecord_pai_approval_requested_date
                 */
                'AND',
                [
                    'custrecord_pai_approval_requested_date',
                    'isnotempty',
                    ''
                ],
                'AND',
                [
                    INSTANCE_COMPLETED_DATE_FIELD,
                    'isempty',
                    ''
                ]
            ],
            /*
             * settings: [{ name: 'consolidationtype', value: 'NONE' }]
             * was removed - it's only valid on Transaction-type
             * searches, and this search's type is
             * customrecord_demo_approval_instance (a custom record),
             * not a transaction, so NetSuite rejected it with
             * SSS_INVALID_SRCH_SETTING. It's also unnecessary now:
             * fxamount (below) already returns the un-consolidated,
             * transaction-currency amount directly.
             */
            columns: [
                search.createColumn({
                    name: 'custrecord_pai_po'
                }),
              search.createColumn({name: 'custrecord_pai_approver'}),
              search.createColumn({name: 'custrecord_pai_delegate'}),
              search.createColumn({
                  name: 'custrecord_pai_approval_requested_date'
              }),
            ]
        });

        approvalSearch.run().each((result) => {
            const billId = result.getValue({
                name: 'custrecord_pai_po'
            });

            if (!billId) {
                return true;
            }

            if (justProcessed[String(billId)]) {
                return true;
            }

            if (seenBills[billId]) {
                return true;
            }
          var approverId = result.getValue({
name: 'custrecord_pai_approver'
});
          var delegateId = result.getValue({name: 'custrecord_pai_delegate'});
          var requestedDateValue = result.getValue({
              name: 'custrecord_pai_approval_requested_date'
          });

            seenBills[billId] = true;

            try {
                const billLookup = search.lookupFields({
                    type: config.searchType,
                    id: billId,
                    columns: [
                        'transactionnumber',
                        'tranid',
                        'entity',
                        'fxamount',
                        'currency',
                        'subsidiary',
                        'trandate',
                        'nextapprover',
                        'approvalstatus',
                        'custbody_demo_transaction_created_by'
                    ]
                });

                /*
                 * search.lookupFields does NOT reliably throw when
                 * billId belongs to a record that isn't actually this
                 * transaction type - it can succeed and just return
                 * blank values for fields that don't apply. That
                 * produces a row with no Number/Vendor/Amount and a
                 * View link that fails with NetSuite's own
                 * "Transaction type specified is incorrect" notice
                 * when clicked. Skip anything that doesn't resolve
                 * to a real record (no tranid AND no transactionnumber)
                 * rather than showing a dead-end row.
                 *
                 * This points to bad underlying data - some
                 * customrecord_demo_approval_instance row has
                 * custrecord_pai_po pointing at an internal ID that
                 * isn't actually a {entityLabel}. Worth cleaning up
                 * at the source; the details below identify which
                 * instance.
                 */
                if (
                    !billLookup.tranid &&
                    !billLookup.transactionnumber
                ) {
                    log.error({
                        title:
                            'Skipping Approval Instance - PO Field ' +
                            'Does Not Resolve To A ' +
                            config.entityLabel,
                        details: {
                            billId: billId,
                            billLookup: billLookup
                        }
                    });

                    return true;
                }

                const nextApproverId = getLookupId(
                    billLookup.nextapprover
                );

                /*
                 * The approval instance may allow the current user
                 * as a delegate, even when the transaction's
                 * nextapprover is the original approver.
                 *
                 * Therefore, do not exclude the bill here only because
                 * nextapprover does not equal the delegate.
                 */
                const approvalStatus = getLookupId(
                    billLookup.approvalstatus
                );

                if (
                    approvalStatus &&
                    String(approvalStatus) !== '1'
                ) {
                    log.debug({
                        title: 'Skipping Record - Not Pending',
                        details: {
                            billId: billId,
                            approvalStatus: approvalStatus
                        }
                    });

                    return true;
                }

                /*
                 * Self-approval exclusion, mirroring
                 * demo_add_approve_and_reject_button_UE (Self
                 * Approval Code): if the transaction creator IS the
                 * next approver, and that next approver IS the
                 * current user, this is a self-approval - don't
                 * show it in the list at all. Unlike the UE script,
                 * there's no admin exception here since the ask was
                 * simply "should not come in the list".
                 */
                const tranCreatedById = getLookupId(
                    billLookup.custbody_demo_transaction_created_by
                );

                const isSelfApproval =
                    tranCreatedById &&
                    nextApproverId &&
                    String(tranCreatedById) ===
                        String(nextApproverId) &&
                    String(currentUserId) ===
                        String(nextApproverId);

                if (isSelfApproval) {
                    log.debug({
                        title: 'Skipping Record - Self Approval',
                        details: {
                            billId: billId,
                            tranCreatedById: tranCreatedById,
                            nextApproverId: nextApproverId,
                            currentUserId: currentUserId
                        }
                    });

                    return true;
                }

                /*
                 * Delay: whole days since the current approval
                 * instance was requested. requestedDateValue comes
                 * back as a display-formatted string (e.g.
                 * "6/20/2026") from the search result, not a raw
                 * date - parse it the same way the browser would.
                 */
                let delayDays = '';

                if (requestedDateValue) {
                    const requestedDate = new Date(
                        requestedDateValue
                    );

                    if (!isNaN(requestedDate.getTime())) {
                        const msPerDay = 24 * 60 * 60 * 1000;

                        delayDays = Math.max(
                            0,
                            Math.floor(
                                (
                                    Date.now() -
                                    requestedDate.getTime()
                                ) / msPerDay
                            )
                        );
                    }
                }

                results.push({
                    billId: String(billId),

                    billnumber:
                        billLookup.transactionnumber || '',

                    referenceNumber:
                        billLookup.tranid || '',

                    vendor:
                        getLookupText(billLookup.entity),

                    amount:
                        billLookup.fxamount || '',

                    currency:
                        getLookupText(billLookup.currency),

                    requestor:
                        getLookupText(
                            billLookup.custbody_demo_transaction_created_by
                        ),

                    delayDays:
                        delayDays === '' ? '' : String(delayDays),

                    subsidiary:
                        getLeafSubsidiary(
                            getLookupText(billLookup.subsidiary)
                        ),

                    billDate:
                        billLookup.trandate || '',

                    comment: '',

                    nextApproverId:
                        nextApproverId
                });

                log.debug({
                    title: config.entityLabel + ' Added',
                    details: {
                        billId: billId,
                        billNumber:
                            billLookup.transactionnumber,
                        referenceNumber:
                            billLookup.tranid
                    }
                });
            } catch (error) {
                log.error({
                    title:
                        'Unable to Read ' +
                        config.entityLabel + ' ' +
                        billId,
                    details: error
                });
            }

            return true;
        });

        return results;
    };

    /**
     * Process selected Vendor Bills and Purchase Orders for APPROVAL
     */
    const processApprovals = (context) => {
        const request = context.request;
        const currentUserId = runtime.getCurrentUser().id;

        let approvedCount = 0;
        let skippedCount = 0;
        let selectedCount = 0;

        const errors = [];
        const processedBillIds = [];

        getTransactionTypes().forEach((config) => {
            const lineCount = request.getLineCount({
                group: config.sublistId
            });

            log.debug({
                title:
                    'Bulk Approval - Line Count - ' +
                    config.entityLabel,
                details: lineCount
            });

            for (let line = 0; line < lineCount; line++) {
                const selected = request.getSublistValue({
                    group: config.sublistId,
                    name: 'custpage_select',
                    line: line
                });

                if (selected !== 'T') {
                    continue;
                }

                selectedCount++;

                const billId = request.getSublistValue({
                    group: config.sublistId,
                    name: 'custpage_internalid',
                    line: line
                });

                const approverComment =
                    request.getSublistValue({
                        group: config.sublistId,
                        name: 'custpage_comment',
                        line: line
                    }) || '';

                if (!billId) {
                    skippedCount++;

                    errors.push(
                        'A selected line did not contain a ' +
                        config.entityLabel + ' ID.'
                    );

                    continue;
                }

                try {
                    /*
                     * Revalidate the approval before updating
                     * anything.
                     */
                    const authorisation =
                        getAuthorisedApprovalInstance(
                            billId,
                            currentUserId,
                            config
                        );

                    if (!authorisation.authorised) {
                        skippedCount++;

                        errors.push(
                            config.entityLabel + ' ' +
                            billId +
                            ': You are no longer authorised ' +
                            'to approve it.'
                        );

                        continue;
                    }

                    /*
                     * Save the comment on the current approval
                     * instance.
                     */
                    if (authorisation.instanceId) {
                        record.submitFields({
                            type:
                                'customrecord_demo_approval_instance',
                            id:
                                authorisation.instanceId,
                            values: {
                                custrecord_pai_approver_comment:
                                    approverComment
                            },
                            options: {
                                enableSourcing: false,
                                ignoreMandatoryFields: true
                            }
                        });
                    }

                    /*
                     * Save the comment in:
                     * custbody_demo_approval_reject_reason
                     *
                     * This is retained because the existing
                     * workflow reads this field when processing
                     * the approval.
                     *
                     * custbody_demo_current_approval_done is also
                     * set to 1 to trigger the existing approval
                     * workflow. Confirmed the same field IDs apply
                     * to both Vendor Bill and Purchase Order.
                     */
                    record.submitFields({
                        type: config.recordType,
                        id: billId,
                        values: {
                            custbody_demo_approval_reject_reason:
                                approverComment,

                            custbody_demo_current_approval_done:
                                '1'
                        },
                        options: {
                            enableSourcing: false,
                            ignoreMandatoryFields: true
                        }
                    });

                    approvedCount++;
                    processedBillIds.push(String(billId));

                    log.audit({
                        title:
                            'Bulk Approval Triggered - ' +
                            config.entityLabel,
                        details: {
                            billId: billId,
                            instanceId:
                                authorisation.instanceId,
                            approverId:
                                currentUserId,
                            comment:
                                approverComment
                        }
                    });
                } catch (error) {
                    log.error({
                        title:
                            'Bulk Approval Error - ' +
                            config.entityLabel + ' - ' +
                            billId,
                        details: error
                    });

                    errors.push(
                        config.entityLabel + ' ' +
                        billId +
                        ': ' +
                        (
                            error.message ||
                            error.toString()
                        )
                    );
                }
            }
        });

        if (selectedCount === 0) {
            errors.push(
                'No Vendor Bills or Purchase Orders were ' +
                'selected for approval.'
            );
        }

        redirectToSuitelet({
            success: approvedCount,
            skipped: skippedCount,
            errors: errors,
            processed: processedBillIds
        });
    };

    /**
     * Process selected Vendor Bills for REJECTION.
     *
     * Uses the SAME mechanism approve already relies on - confirmed
     * against Email_Plugin_For_Vendor_Bill.js, which handles the
     * email-reply approval path for this same workflow:
     *
     *   1. Close out the current approval instance directly
     *      (custrecord_pai_approval_status, completed date, channel,
     *      comment) - the instance record itself isn't part of the
     *      workflow, so this Suitelet must set it explicitly.
     *   2. Set custbody_demo_current_approval_done = 2 (Reject) on the
     *      Vendor Bill. This fires Approval_Level_Update_WFA
     *      (bound to the "Approval Pending" state's ONENTRY event),
     *      which sets approvalstatus, clears the level/nextapprover
     *      fields, and actually transitions the SuiteFlow instance -
     *      which is what makes the record's Approve/Reject/
     *      Re-Submit buttons update correctly. It then clears the
     *      field itself to prevent re-looping.
     *
     * This script must NOT set approvalstatus,
     * custbody_demo_approval_current_level,
     * custbody_demo_last_approval_level, or nextapprover directly -
     * that bypasses the workflow entirely and was the earlier bug
     * (fields looked right, but the record's real workflow state
     * never moved, so old Approve/Reject buttons kept showing).
     */
    const processRejections = (context) => {
        const request = context.request;
        const currentUserId = runtime.getCurrentUser().id;

        let rejectedCount = 0;
        let skippedCount = 0;
        let selectedCount = 0;

        const errors = [];
        const processedBillIds = [];

        getTransactionTypes().forEach((config) => {
            const lineCount = request.getLineCount({
                group: config.sublistId
            });

            log.debug({
                title:
                    'Bulk Rejection - Line Count - ' +
                    config.entityLabel,
                details: lineCount
            });

            for (let line = 0; line < lineCount; line++) {
                const selected = request.getSublistValue({
                    group: config.sublistId,
                    name: 'custpage_select',
                    line: line
                });

                if (selected !== 'T') {
                    continue;
                }

                selectedCount++;

                const billId = request.getSublistValue({
                    group: config.sublistId,
                    name: 'custpage_internalid',
                    line: line
                });

                const approverComment =
                    request.getSublistValue({
                        group: config.sublistId,
                        name: 'custpage_comment',
                        line: line
                    }) || '';

                if (!billId) {
                    skippedCount++;

                    errors.push(
                        'A selected line did not contain a ' +
                        config.entityLabel + ' ID.'
                    );

                    continue;
                }

                /*
                 * Standard process requires a comment/reason
                 * whenever a record is rejected.
                 */
                if (!approverComment.trim()) {
                    skippedCount++;

                    errors.push(
                        config.entityLabel + ' ' +
                        billId +
                        ': A comment is required to reject a ' +
                        'record.'
                    );

                    continue;
                }

                try {
                    /*
                     * Revalidate the approval before updating
                     * anything - same check used before approving.
                     */
                    const authorisation =
                        getAuthorisedApprovalInstance(
                            billId,
                            currentUserId,
                            config
                        );

                    if (!authorisation.authorised) {
                        skippedCount++;

                        errors.push(
                            config.entityLabel + ' ' +
                            billId +
                            ': You are no longer authorised ' +
                            'to reject it.'
                        );

                        continue;
                    }

                    /*
                     * Close out the current approval instance -
                     * same fields/values the email-reply approval
                     * plugin uses for a REJECT action
                     * (customrecord_demo_approval_instance):
                     *   custrecord_pai_approval_status = 3 (Rejected)
                     *   custrecord_pai_approval_completed_date = now
                     *   custrecord_pai_channel_used = 1 (UI Button,
                     *     since this comes from the Suitelet, not an
                     *     email reply)
                     *   custrecord_pai_approver_comment = the comment
                     */
                    if (authorisation.instanceId) {
                        record.submitFields({
                            type:
                                'customrecord_demo_approval_instance',
                            id:
                                authorisation.instanceId,
                            values: {
                                custrecord_pai_approver_comment:
                                    approverComment,

                                custrecord_pai_approval_status:
                                    INSTANCE_STATUS_REJECTED,

                                [INSTANCE_COMPLETED_DATE_FIELD]:
                                    new Date(),

                                custrecord_pai_channel_used:
                                    CHANNEL_UI_BUTTON
                            },
                            options: {
                                enableSourcing: false,
                                ignoreMandatoryFields: true
                            }
                        });
                    }

                    /*
                     * Do NOT set approvalstatus / current level /
                     * last level / nextapprover directly - that was
                     * the bug. Those fields, and the actual SuiteFlow
                     * state transition (so the record's buttons
                     * update correctly), are handled by the SAME
                     * workflow action approve already relies on
                     * (Approval_Level_Update_WFA, fired on
                     * "Approval Pending" ONENTRY). That script reads
                     * custbody_demo_current_approval_done as a signal:
                     * 1 = Approve, 2 = Reject (confirmed from the
                     * email capture plugin's REJECT handling), then
                     * clears the field itself afterward to prevent
                     * re-looping. Confirmed the same field IDs apply
                     * to both Vendor Bill and Purchase Order.
                     */
                    record.submitFields({
                        type: config.recordType,
                        id: billId,
                        values: {
                            custbody_demo_approval_reject_reason:
                                approverComment,

                            custbody_demo_current_approval_done:
                                REJECT_DONE_VALUE
                        },
                        options: {
                            enableSourcing: false,
                            ignoreMandatoryFields: true
                        }
                    });

                    rejectedCount++;
                    processedBillIds.push(String(billId));

                    log.audit({
                        title:
                            'Bulk Rejection Processed - ' +
                            config.entityLabel,
                        details: {
                            billId: billId,
                            instanceId:
                                authorisation.instanceId,
                            approverId:
                                currentUserId,
                            comment:
                                approverComment
                        }
                    });
                } catch (error) {
                    log.error({
                        title:
                            'Bulk Rejection Error - ' +
                            config.entityLabel + ' - ' +
                            billId,
                        details: error
                    });

                    errors.push(
                        config.entityLabel + ' ' +
                        billId +
                        ': ' +
                        (
                            error.message ||
                            error.toString()
                        )
                    );
                }
            }
        });

        if (selectedCount === 0) {
            errors.push(
                'No Vendor Bills or Purchase Orders were ' +
                'selected for rejection.'
            );
        }

        redirectToSuitelet({
            rejected: rejectedCount,
            skipped: skippedCount,
            errors: errors,
            processed: processedBillIds
        });
    };

    /**
     * Revalidate the current user's approval authority
     */
    const getAuthorisedApprovalInstance = (
        billId,
        currentUserId,
        config
    ) => {
        const authorisation = {
            authorised: false,
            instanceId: ''
        };

        const approvalSearch = search.create({
            type: 'customrecord_demo_approval_instance',
            filters: [
                [
                    'custrecord_pai_po',
                    'anyof',
                    billId
                ],
                'AND',
                [
                    [
                        'custrecord_pai_approver',
                        'anyof',
                        currentUserId
                    ],
                    'OR',
                    [
                        'custrecord_pai_delegate',
                        'anyof',
                        currentUserId
                    ]
                ],
                'AND',
                [
                    'custrecord_pai_approval_status',
                    'anyof',
                    '1'
                ],
                'AND',
                [
                    'custrecord_demo_pia_historical',
                    'is',
                    'F'
                ],
                'AND',
                [
                    'custrecord_demo_main_po_approval_conf.' +
                    'custrecord_pac_record_type',
                    'anyof',
                    config.recordTypeFilterValue
                ],
                'AND',
                [
                    'custrecord_pai_po.nextapprover',
                    'anyof',
                    currentUserId
                ],
                'AND',
                [
                    'custrecord_pai_po.datecreated',
                    'onorafter',
                    '06/15/2026 12:00 am'
                ],
                /*
                 * Confirmed field ID:
                 * custrecord_pai_approval_requested_date
                 */
                'AND',
                [
                    'custrecord_pai_approval_requested_date',
                    'isnotempty',
                    ''
                ],
                'AND',
                [
                    INSTANCE_COMPLETED_DATE_FIELD,
                    'isempty',
                    ''
                ]
            ],
            columns: [
                search.createColumn({
                    name: 'internalid'
                })
            ]
        });

        approvalSearch.run().each((result) => {
            authorisation.authorised = true;

            authorisation.instanceId =
                result.getValue({
                    name: 'internalid'
                });

            return false;
        });

        if (!authorisation.authorised) {
            log.debug({
                title:
                    'Authorisation Failed - Approval Instance',
                details: {
                    billId: billId,
                    currentUserId: currentUserId
                }
            });

            return authorisation;
        }

        /*
         * Validate that the record is still pending approval, and
         * re-check self-approval hasn't somehow been bypassed via a
         * stale page.
         */
        const billLookup = search.lookupFields({
            type: config.searchType,
            id: billId,
            columns: [
                'approvalstatus',
                'nextapprover',
                'custbody_demo_transaction_created_by'
            ]
        });

        const approvalStatus = getLookupId(
            billLookup.approvalstatus
        );

        if (
            approvalStatus &&
            String(approvalStatus) !== '1'
        ) {
            log.debug({
                title:
                    'Authorisation Failed - Record Not Pending',
                details: {
                    billId: billId,
                    approvalStatus: approvalStatus
                }
            });

            authorisation.authorised = false;

            return authorisation;
        }

        const nextApproverId = getLookupId(
            billLookup.nextapprover
        );

        const tranCreatedById = getLookupId(
            billLookup.custbody_demo_transaction_created_by
        );

        const isSelfApproval =
            tranCreatedById &&
            nextApproverId &&
            String(tranCreatedById) === String(nextApproverId) &&
            String(currentUserId) === String(nextApproverId);

        if (isSelfApproval) {
            log.debug({
                title:
                    'Authorisation Failed - Self Approval',
                details: {
                    billId: billId,
                    tranCreatedById: tranCreatedById,
                    nextApproverId: nextApproverId,
                    currentUserId: currentUserId
                }
            });

            authorisation.authorised = false;
        }

        return authorisation;
    };

    /**
     * Redirect back to the current Suitelet
     */
    const redirectToSuitelet = (result) => {
        const currentScript = runtime.getCurrentScript();

        const suiteletUrl = url.resolveScript({
            scriptId: currentScript.id,
            deploymentId: currentScript.deploymentId,
            params: {
                success:
                    String(result.success || 0),

                rejected:
                    String(result.rejected || 0),

                skipped:
                    String(result.skipped || 0),

                errors:
                    (result.errors || []).join(' | '),

                processed:
                    (result.processed || []).join(',')
            }
        });

        redirect.redirect({
            url: suiteletUrl
        });
    };

    /**
     * Get the internal ID from a lookupFields result
     */
    const getLookupId = (value) => {
        if (Array.isArray(value)) {
            if (value.length > 0) {
                return value[0].value || '';
            }

            return '';
        }

        return value || '';
    };

    /**
     * Get display text from a lookupFields result
     */
    const getLookupText = (value) => {
        if (Array.isArray(value)) {
            if (value.length > 0) {
                return (
                    value[0].text ||
                    value[0].value ||
                    ''
                );
            }

            return '';
        }

        return value || '';
    };

    /**
     * Subsidiary text comes back as a full hierarchy path, e.g.
     * "Parent Company USD : Demo Group : Demo Inc." -
     * return just the leaf name ("Demo Inc.").
     */
    const getLeafSubsidiary = (value) => {
        if (!value) {
            return '';
        }

        const parts = String(value).split(':');

        return parts[parts.length - 1].trim();
    };

    /**
     * Escape dynamic text shown in INLINEHTML
     */
    const escapeHtml = (value) => {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    return {
        onRequest: onRequest
    };
});
``
