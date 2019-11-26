/// <reference path="../test-types.ts"/>

import * as _ from 'lodash';
import * as assert from 'assert';
import { logUnusual, dieIf } from './log-and-die';


declare const settings;

function firstDefinedOf(x, y, z?) {
  return !_.isUndefined(x) ? x : (!_.isUndefined(y) ? y : z);
}

function encodeInBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const utils = {

  firstDefinedOf,

  encodeInBase64,

  regexEscapeSlashes: function(origin: string): string {
    return origin.replace(/\//g, '\\/');
  },

  generateTestId: function(): string {
    return Date.now().toString().slice(3, 10);
  },

  makeSiteOrigin: function(localHostname: string): string {
    return settings.scheme + '://' + localHostname + '.' + settings.newSiteDomain;
  },

  makeSiteOriginRegexEscaped: function(localHostname: string): string {
    return settings.scheme + ':\\/\\/' + localHostname + '.' + settings.newSiteDomain;
  },

  makeCreateSiteWithFakeIpUrl: function () {
    return utils._makeCreateSiteUrlImpl(false);
  },

  makeCreateEmbeddedSiteWithFakeIpUrl: function () {
    return utils._makeCreateSiteUrlImpl(true);
  },

  _makeCreateSiteUrlImpl: function (isEmbeddedSite: boolean) {
    function randomIpPart() { return '.' + Math.floor(Math.random() * 256); }
    const ip = '0' + randomIpPart() + randomIpPart() + randomIpPart();
    const embedded = isEmbeddedSite ? '/embedded-comments' : '';
    return settings.mainSiteOrigin + `/-/create-site${embedded}?fakeIp=${ip}` +
        `&e2eTestPassword=${settings.e2eTestPassword}&testSiteOkDelete=true`;
  },

  findFirstLinkToUrlIn: function(url: string, text: string): string {
    return utils._findFirstLinkToUrlImpl(url, text, true);
  },

  findAnyFirstLinkToUrlIn: function(url: string, text: string): string {
    return utils._findFirstLinkToUrlImpl(url, text, false);
  },

  _findFirstLinkToUrlImpl: function(url: string, text: string, mustMatch: boolean): string {
    // Make sure ends with ", otherwise might find: <a href="..">http://this..instead..of..the..href</a>.
    // This:  (?: ...)  is a non-capture group, so the trailing " won't be incl in the match.
    const regexString = '(' + utils.regexEscapeSlashes(url) + '[^"\']*)(?:["\'])';
    const matches = text.match(new RegExp(regexString));
    dieIf(mustMatch && !matches,
        `No link matching /${regexString}/ found in email [EsE5GPYK2], text: ${text}`);
    return matches ? matches[1] : undefined;
  },

  makeExternalUserFor: (member: Member, opts: {
    ssoId: string;
    primaryEmailAddress?: string,
    isEmailAddressVerified?: boolean,
    username?: string,
    fullName?: string,
    avatarUrl?: string,
    aboutUser?: string,
    isAdmin?: boolean,
    isModerator?: boolean,
  }): ExternalUser => {
    return {
      ssoId: opts.ssoId,
      primaryEmailAddress: firstDefinedOf(opts.primaryEmailAddress, member.emailAddress),
      isEmailAddressVerified: firstDefinedOf(opts.isEmailAddressVerified, !!member.emailVerifiedAtMs),
      username: firstDefinedOf(opts.username, member.username),
      fullName: firstDefinedOf(opts.fullName, member.fullName),
      avatarUrl: opts.avatarUrl,
      aboutUser: opts.aboutUser,
      isAdmin: firstDefinedOf(opts.isAdmin, member.isAdmin),
      isModerator: firstDefinedOf(opts.isModerator, member.isModerator),
    };
  },

  makeEmbeddedCommentsHtml(ps: { pageName: string, discussionId?: string,
      localHostname?: string, color?: string, bgColor: string, htmlToPaste?: string }): string {
    // Dupl code [046KWESJJLI3].
    dieIf(!!ps.localHostname && !!ps.htmlToPaste, 'TyE502PK562');
    dieIf(!ps.localHostname && !ps.htmlToPaste, 'TyE7FHQJ45X');
    let htmlToPaste = ps.htmlToPaste;
    if (ps.discussionId && htmlToPaste) {
      htmlToPaste = htmlToPaste.replace(
        ` data-discussion-id=""`, ` data-discussion-id="${ps.discussionId}"`);
    }
    const ieEmpty = !ps.discussionId ? ', i.e. <b>no</b> id' : '';
    return `
<html>
<head><title>Embedded comments E2E test</title></head>
<body style="background: ${ps.bgColor || 'black'}; color: ${ps.color || '#ccc'}; font-family: monospace; font-weight: bold;">
<p>Embedded comments E2E test page "${ps.pageName}".<br>
Discussion id: "${ps.discussionId || ''}"${ieEmpty}.<br>
Ok to delete. The comments: (generated by the admin js bundle [2JKWTQ0])</p>
<hr>
${ htmlToPaste ? htmlToPaste : `
<script>talkyardServerUrl='http://${ps.localHostname}.localhost';</script>
<script async defer src="http://${ps.localHostname}.localhost/-/talkyard-comments.js"></script>
<div class="talkyard-comments" data-discussion-id="${ps.discussionId}" style="margin-top: 45px;">
`}
<hr>
<p>/End of page.</p>
</body>
</html>`;
  },

  checkNewPageFields: (page, ps: { categoryId: CategoryId, authorId: UserId }) => {
    assert.equal(page.htmlTagCssClasses, "");
    assert.equal(page.hiddenAt, null);
    assert(!!page.createdAtMs);
    assert(!!page.publishedAtMs);
    assert.equal(page.numLikes, 0);
    assert.equal(page.numWrongs, 0);
    assert.equal(page.numBurys, 0);
    assert.equal(page.numUnwanteds, 0);
    assert.equal(page.numOrigPostLikeVotes, 0);
    assert.equal(page.numOrigPostWrongVotes, 0);
    assert.equal(page.numOrigPostBuryVotes, 0);
    assert.equal(page.numOrigPostUnwantedVotes, 0);
    assert.equal(page.numPostsTotal, 2);
    assert.equal(page.numRepliesTotal, 0);
    assert.equal(page.numRepliesVisible, 0);
    assert.equal(page.numOrigPostRepliesVisible, 0);
    assert.equal(page.answeredAt, null);
    assert.equal(page.lockedAt, null);
    assert.equal(page.plannedAt, null);
    assert.equal(page.startedAt, null);
    assert.equal(page.pinOrder, null);
    assert.equal(page.lastApprovedReplyById, null);
    assert(!!page.updatedAtMs);
    assert.equal(page.bumpedAtMs, null);
    assert.equal(page.doingStatus, 1);
    assert.equal(page.closedAt, null);
    assert.equal(page.htmlHeadDescription, "");
    assert.equal(page.doneAt, null);
    assert.equal(page.authorId, ps.authorId);
    assert.equal(page.version, 1);
    assert.equal(page.answerPostId, null);
    assert.equal(page.layout, 0);
    assert.equal(page.htmlHeadTitle, "");
    assert.equal(page.deletedAt, null);
    assert.equal(page.pinWhere, null);
    assert.equal(page.embeddingPageUrl, null);
    assert.equal(page.lastApprovedReplyAt, null);
    assert(!!page.frequentPosterIds);
    assert.equal(page.frequentPosterIds.length, 0);
    assert.equal(page.unwantedAt, null);
    assert.equal(page.frozenAt, null);
    assert.equal(page.categoryId, ps.categoryId);
  },


  tryManyTimes: (what, maxNumTimes, fn) => {
    for (let retryCount = 0; retryCount < maxNumTimes - 1; ++retryCount) {
      try {
        fn();
        return;
      }
      catch (error) {
        logUnusual(`RETRYING: ${what}  [TyME2ERETRY], because error: ${error.toString()}`);
      }
    }
    fn();
  },
};


export = utils;