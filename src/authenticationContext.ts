import { AdalConfig } from "./adalConfig";
import { User } from "./user";
import { Constants } from "./Constants";
import { RequestType } from "./requestType";
import { ResponseType } from "./responseType";
import { TokenReceivedCallback } from "./tokenReceivedCallback";
import { Utils } from "./Utils";
import { TokenResponse } from "./RequestInfo";

export class AuthenticationContext {
  public instance: string = 'https://login.microsoftonline.com/';
  public config: AdalConfig;
  public callback: TokenReceivedCallback = null;
  public popUp: boolean = false;
  public isAngular: boolean = false;

  private _user : User = null;
  private _activeRenewals = {};
  private _loginInProgress = false;
  private _acquireTokenInProgress = false;
  private _renewStates: any = []; // <==================
  private _callBackMappedToRenewStates = {};
  private _callBacksMappedToRenewStates = {};
  private _openedWindows: any = []; // <=====================
  private _requestType: string = RequestType.LOGIN;
  private _idTokenNonce: string;

  private static _singletonInstance: AuthenticationContext = null;

  //window._adalInstance = this;   //  <===================

  constructor(config: AdalConfig) {
    if (AuthenticationContext._singletonInstance != null)
      return AuthenticationContext._singletonInstance;
    else
      AuthenticationContext._singletonInstance = this;

    // clientId is required
    if (!config.clientId) {
      throw new Error("clientId is required");
    }

    this.config = config; // <============== need deep copy  _cloneConfig

    if (this.config.popUp) {
      this.popUp = true;
    }

    this.callback = this.config.callback;

    if (this.config.instance) {
      this.instance = this.config.instance;
    }

    // App can request idtoken for itself using clientid as resource
    if (!this.config.loginResource) {
      this.config.loginResource = this.config.clientId;
    }

    // redirect and logout_redirect are set to current location by default
    if (!this.config.redirectUri) {
      // strip off query parameters or hashes from the redirect uri as AAD does not allow those.
      this.config.redirectUri = window.location.href.split("?")[0].split("#")[0];
    }

    if (!this.config.postLogoutRedirectUri) {
      // strip off query parameters or hashes from the post logout redirect uri as AAD does not allow those.
      this.config.postLogoutRedirectUri = window.location.href.split("?")[0].split("#")[0];
    }

    if (!this.config.anonymousEndpoints) {
      this.config.anonymousEndpoints = [];
    }

    if (this.config.isAngular) {
      this.isAngular = this.config.isAngular;
    }

    if (this.config.loadFrameTimeout) {
      Constants.LOADFRAME_TIMEOUT = this.config.loadFrameTimeout;
    }

    // if (typeof window !== 'undefined') {
    //     window.Logging = {
    //         level: 0,
    //         log: function (message) { }
    //     };
    // }
  }

  /**
   * Initiates the login process by redirecting the user to Azure AD authorization endpoint.
   */
  public login(): void {
    if (this._loginInProgress) {
      //this.info("Login in progress");
      return;
    }

    this._loginInProgress = true;

    // Token is not present and user needs to login
    var expectedState = Utils.createNewGuid();
    this.config.state = expectedState;
    this._idTokenNonce = Utils.createNewGuid();
    var loginStartPage = this._getItem(this.CONSTANTS.STORAGE.ANGULAR_LOGIN_REQUEST);

    if (!loginStartPage || loginStartPage === "") {
      loginStartPage = window.location.href;
    }
    else {
      this._saveItem(this.CONSTANTS.STORAGE.ANGULAR_LOGIN_REQUEST, "")
    }

    this.verbose('Expected state: ' + expectedState + ' startPage:' + loginStartPage);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_REQUEST, loginStartPage);
    this._saveItem(this.CONSTANTS.STORAGE.LOGIN_ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.STATE_LOGIN, expectedState, true);
    this._saveItem(this.CONSTANTS.STORAGE.NONCE_IDTOKEN, this._idTokenNonce, true);
    this._saveItem(this.CONSTANTS.STORAGE.ERROR, '');
    this._saveItem(this.CONSTANTS.STORAGE.ERROR_DESCRIPTION, '');
    var urlNavigate = this._getNavigateUrl('id_token', null) + '&nonce=' + encodeURIComponent(this._idTokenNonce);

    if (this.config.displayCall) {
      // User defined way of handling the navigation
      this.config.displayCall(urlNavigate);
    }
    else if (this.popUp) {
      this._saveItem(this.CONSTANTS.STORAGE.STATE_LOGIN, '');// so requestInfo does not match redirect case
      this._renewStates.push(expectedState);
      this.registerCallback(expectedState, this.config.clientId, this.callback);
      this._loginPopup(urlNavigate);
    }
    else {
      this.promptUser(urlNavigate);
    }
  };

  /*
   * Returns the anchor part(#) of the URL
   * @ignore
   * @hidden
   */
  private getHash(hash: string): string {
    if (hash.indexOf("#/") > -1) {
      hash = hash.substring(hash.indexOf("#/") + 2);
    } else if (hash.indexOf("#") > -1) {
      hash = hash.substring(1);
    }

    return hash;
  }

    /*
   * Checks if the redirect response is received from the STS. In case of redirect, the url fragment has either id_token, access_token or error.
   * @param {string} hash - Hash passed from redirect page.
   * @returns {Boolean} - true if response contains id_token, access_token or error, false otherwise.
   * @hidden
   */
  isCallback(hash: string): boolean {
    hash = this.getHash(hash);
    const parameters = Utils.deserialize(hash);
    return (
      parameters.hasOwnProperty(Constants.errorDescription) ||
      parameters.hasOwnProperty(Constants.error) ||
      parameters.hasOwnProperty(Constants.accessToken) ||
      parameters.hasOwnProperty(Constants.idToken)

    );
  }

  /*
  * Creates a requestInfo object from the URL fragment and returns it.
  * @param {string} hash  -  Hash passed from redirect page
  * @returns {TokenResponse} an object created from the redirect response from AAD comprising of the keys - parameters, requestType, stateMatch, stateResponse and valid.
  * @ignore
  * @hidden
  */
  private getRequestInfo(hash: string): TokenResponse {
    hash = this.getHash(hash);
    const parameters = Utils.deserialize(hash);
    const tokenResponse = new TokenResponse();
    if (parameters) {
      tokenResponse.parameters = parameters;
      if (parameters.hasOwnProperty(Constants.errorDescription) ||
        parameters.hasOwnProperty(Constants.error) ||
        parameters.hasOwnProperty(Constants.accessToken) ||
        parameters.hasOwnProperty(Constants.idToken)) {
        tokenResponse.valid = true;
        // which call
        let stateResponse: string;
        if (parameters.hasOwnProperty("state")) {
            stateResponse = parameters.state;
        } else {
            return tokenResponse;
        }

        tokenResponse.stateResponse = stateResponse;
        // async calls can fire iframe and login request at the same time if developer does not use the API as expected
        // incoming callback needs to be looked up to find the request type
        if (stateResponse === this._cacheStorage.getItem(Constants.stateLogin)) { // loginRedirect
          tokenResponse.requestType = Constants.login;
          tokenResponse.stateMatch = true;
          return tokenResponse;
        } else if (stateResponse === this._cacheStorage.getItem(Constants.stateAcquireToken)) { //acquireTokenRedirect
          tokenResponse.requestType = Constants.renewToken;
          tokenResponse.stateMatch = true;
          return tokenResponse;
        }

        // external api requests may have many renewtoken requests for different resource
        if (!tokenResponse.stateMatch) {
          if (window.parent && window.parent !== window) {
            tokenResponse.requestType = Constants.renewToken;
          }
          else {
            tokenResponse.requestType = this._requestType;
          }
          const statesInParentContext = this._renewStates;
          for (let i = 0; i < statesInParentContext.length; i++) {
            if (statesInParentContext[i] === tokenResponse.stateResponse) {
              tokenResponse.stateMatch = true;
              break;
            }
          }
        }
      }
    }
    return tokenResponse;
  }
}