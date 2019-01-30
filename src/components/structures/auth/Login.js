/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018, 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

import React from 'react';
import PropTypes from 'prop-types';
import { _t, _td } from '../../../languageHandler';
import sdk from '../../../index';
import Login from '../../../Login';
import SdkConfig from '../../../SdkConfig';
import { messageForResourceLimitError } from '../../../utils/ErrorUtils';
import { AutoDiscovery } from "matrix-js-sdk";
import * as ServerType from '../../views/auth/ServerTypeSelector';

// For validating phone numbers without country codes
const PHONE_NUMBER_REGEX = /^[0-9()\-\s]*$/;

// Phases
// Show controls to configure server details
const PHASE_SERVER_DETAILS = 0;
// Show the appropriate login flow(s) for the server
const PHASE_LOGIN = 1;

// Disable phases for now, pending UX discussion on WK discovery
const PHASES_ENABLED = false;

// These are used in several places, and come from the js-sdk's autodiscovery
// stuff. We define them here so that they'll be picked up by i18n.
_td("Invalid homeserver discovery response");
_td("Invalid identity server discovery response");
_td("General failure");

/**
 * A wire component which glues together login UI components and Login logic
 */
module.exports = React.createClass({
    displayName: 'Login',

    propTypes: {
        onLoggedIn: PropTypes.func.isRequired,

        enableGuest: PropTypes.bool,

        customHsUrl: PropTypes.string,
        customIsUrl: PropTypes.string,
        defaultHsUrl: PropTypes.string,
        defaultIsUrl: PropTypes.string,
        // Secondary HS which we try to log into if the user is using
        // the default HS but login fails. Useful for migrating to a
        // different home server without confusing users.
        fallbackHsUrl: PropTypes.string,

        // An error passed along from higher up explaining that something
        // went wrong when finding the defaultHsUrl.
        defaultServerDiscoveryError: PropTypes.string,

        defaultDeviceDisplayName: PropTypes.string,

        // login shouldn't know or care how registration is done.
        onRegisterClick: PropTypes.func.isRequired,

        // login shouldn't care how password recovery is done.
        onForgotPasswordClick: PropTypes.func,
        onCancelClick: PropTypes.func,
        onServerConfigChange: PropTypes.func.isRequired,
    },

    getInitialState: function() {
        return {
            busy: false,
            errorText: null,
            loginIncorrect: false,

            serverType: null,
            enteredHomeserverUrl: this.props.customHsUrl || this.props.defaultHsUrl,
            enteredIdentityServerUrl: this.props.customIsUrl || this.props.defaultIsUrl,

            // used for preserving form values when changing homeserver
            username: "",
            phoneCountry: null,
            phoneNumber: "",

            // Phase of the overall login dialog.
            phase: PHASE_SERVER_DETAILS,
            // The current login flow, such as password, SSO, etc.
            currentFlow: "m.login.password",

            // .well-known discovery
            discoveredHsUrl: "",
            discoveredIsUrl: "",
            discoveryError: "",
            findingHomeserver: false,
        };
    },

    componentWillMount: function() {
        this._unmounted = false;

        // map from login step type to a function which will render a control
        // letting you do that login type
        this._stepRendererMap = {
            'm.login.password': this._renderPasswordStep,

            // CAS and SSO are the same thing, modulo the url we link to
            'm.login.cas': () => this._renderSsoStep(this._loginLogic.getSsoLoginUrl("cas")),
            'm.login.sso': () => this._renderSsoStep(this._loginLogic.getSsoLoginUrl("sso")),
        };

        this._initLoginLogic();
    },

    componentWillUnmount: function() {
        this._unmounted = true;
    },

    onPasswordLoginError: function(errorText) {
        this.setState({
            errorText,
            loginIncorrect: Boolean(errorText),
        });
    },

    onPasswordLogin: function(username, phoneCountry, phoneNumber, password) {
        // Prevent people from submitting their password when homeserver
        // discovery went wrong
        if (this.state.discoveryError || this.props.defaultServerDiscoveryError) return;

        this.setState({
            busy: true,
            errorText: null,
            loginIncorrect: false,
        });

        this._loginLogic.loginViaPassword(
            username, phoneCountry, phoneNumber, password,
        ).then((data) => {
            this.props.onLoggedIn(data);
        }, (error) => {
            if (this._unmounted) {
                return;
            }
            let errorText;

            // Some error strings only apply for logging in
            const usingEmail = username.indexOf("@") > 0;
            if (error.httpStatus === 400 && usingEmail) {
                errorText = _t('This Home Server does not support login using email address.');
            } else if (error.errcode == 'M_RESOURCE_LIMIT_EXCEEDED') {
                const errorTop = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact, {
                    'monthly_active_user': _td(
                        "This homeserver has hit its Monthly Active User limit.",
                    ),
                    '': _td(
                        "This homeserver has exceeded one of its resource limits.",
                    ),
                });
                const errorDetail = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact, {
                    '': _td(
                        "Please <a>contact your service administrator</a> to continue using this service.",
                    ),
                });
                errorText = (
                    <div>
                        <div>{errorTop}</div>
                        <div className="mx_Login_smallError">{errorDetail}</div>
                    </div>
                );
            } else if (error.httpStatus === 401 || error.httpStatus === 403) {
                if (SdkConfig.get()['disable_custom_urls']) {
                    errorText = (
                        <div>
                            <div>{ _t('Incorrect username and/or password.') }</div>
                            <div className="mx_Login_smallError">
                                { _t('Please note you are logging into the %(hs)s server, not matrix.org.',
                                    {
                                        hs: this.props.defaultHsUrl.replace(/^https?:\/\//, ''),
                                    })
                                }
                            </div>
                        </div>
                    );
                } else {
                    errorText = _t('Incorrect username and/or password.');
                }
            } else {
                // other errors, not specific to doing a password login
                errorText = this._errorTextFromError(error);
            }

            this.setState({
                errorText: errorText,
                // 401 would be the sensible status code for 'incorrect password'
                // but the login API gives a 403 https://matrix.org/jira/browse/SYN-744
                // mentions this (although the bug is for UI auth which is not this)
                // We treat both as an incorrect password
                loginIncorrect: error.httpStatus === 401 || error.httpStatus === 403,
            });
        }).finally(() => {
            if (this._unmounted) {
                return;
            }
            this.setState({
                busy: false,
            });
        }).done();
    },

    _onLoginAsGuestClick: function(ev) {
        ev.preventDefault();
        ev.stopPropagation();

        const self = this;
        self.setState({
            busy: true,
            errorText: null,
            loginIncorrect: false,
        });

        this._loginLogic.loginAsGuest().then(function(data) {
            self.props.onLoggedIn(data);
        }, function(error) {
            let errorText;
            if (error.httpStatus === 403) {
                errorText = _t("Guest access is disabled on this Home Server.");
            } else {
                errorText = self._errorTextFromError(error);
            }
            self.setState({
                errorText: errorText,
                loginIncorrect: false,
            });
        }).finally(function() {
            self.setState({
                busy: false,
            });
        }).done();
    },

    onUsernameChanged: function(username) {
        this.setState({ username: username });
    },

    onUsernameBlur: function(username) {
        this.setState({
            username: username,
            discoveryError: null,
        });
        if (username[0] === "@") {
            const serverName = username.split(':').slice(1).join(':');
            try {
                // we have to append 'https://' to make the URL constructor happy
                // otherwise we get things like 'protocol: matrix.org, pathname: 8448'
                const url = new URL("https://" + serverName);
                this._tryWellKnownDiscovery(url.hostname);
            } catch (e) {
                console.error("Problem parsing URL or unhandled error doing .well-known discovery:", e);
                this.setState({discoveryError: _t("Failed to perform homeserver discovery")});
            }
        }
    },

    onPhoneCountryChanged: function(phoneCountry) {
        this.setState({ phoneCountry: phoneCountry });
    },

    onPhoneNumberChanged: function(phoneNumber) {
        // Validate the phone number entered
        if (!PHONE_NUMBER_REGEX.test(phoneNumber)) {
            this.setState({ errorText: _t('The phone number entered looks invalid') });
            return;
        }

        this.setState({
            phoneNumber: phoneNumber,
            errorText: null,
        });
    },

    onServerConfigChange: function(config) {
        const self = this;
        const newState = {
            errorText: null, // reset err messages
        };
        if (config.hsUrl !== undefined) {
            newState.enteredHomeserverUrl = config.hsUrl;
        }
        if (config.isUrl !== undefined) {
            newState.enteredIdentityServerUrl = config.isUrl;
        }

        this.props.onServerConfigChange(config);
        this.setState(newState, function() {
            self._initLoginLogic(config.hsUrl || null, config.isUrl);
        });
    },

    onServerTypeChange(type) {
        this.setState({
            serverType: type,
        });

        // When changing server types, set the HS / IS URLs to reasonable defaults for the
        // the new type.
        switch (type) {
            case ServerType.FREE: {
                const { hsUrl, isUrl } = ServerType.TYPES.FREE;
                this.onServerConfigChange({
                    hsUrl,
                    isUrl,
                });
                // Move directly to the login phase since the server details are fixed.
                this.setState({
                    phase: PHASE_LOGIN,
                });
                break;
            }
            case ServerType.PREMIUM:
            case ServerType.ADVANCED:
                this.onServerConfigChange({
                    hsUrl: this.props.defaultHsUrl,
                    isUrl: this.props.defaultIsUrl,
                });
                this.setState({
                    phase: PHASE_SERVER_DETAILS,
                });
                break;
        }
    },

    onRegisterClick: function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        this.props.onRegisterClick();
    },

    onServerDetailsNextPhaseClick(ev) {
        ev.stopPropagation();
        this.setState({
            phase: PHASE_LOGIN,
        });
    },

    onEditServerDetailsClick(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        this.setState({
            phase: PHASE_SERVER_DETAILS,
        });
    },

    _tryWellKnownDiscovery: async function(serverName) {
        if (!serverName.trim()) {
            // Nothing to discover
            this.setState({discoveryError: "", discoveredHsUrl: "", discoveredIsUrl: "", findingHomeserver: false});
            return;
        }

        this.setState({findingHomeserver: true});
        try {
            const discovery = await AutoDiscovery.findClientConfig(serverName);
            const state = discovery["m.homeserver"].state;
            if (state !== AutoDiscovery.SUCCESS && state !== AutoDiscovery.PROMPT) {
                this.setState({
                    discoveredHsUrl: "",
                    discoveredIsUrl: "",
                    discoveryError: discovery["m.homeserver"].error,
                    findingHomeserver: false,
                });
            } else if (state === AutoDiscovery.PROMPT) {
                this.setState({
                    discoveredHsUrl: "",
                    discoveredIsUrl: "",
                    discoveryError: "",
                    findingHomeserver: false,
                });
            } else if (state === AutoDiscovery.SUCCESS) {
                this.setState({
                    discoveredHsUrl: discovery["m.homeserver"].base_url,
                    discoveredIsUrl:
                        discovery["m.identity_server"].state === AutoDiscovery.SUCCESS
                            ? discovery["m.identity_server"].base_url
                            : "",
                    discoveryError: "",
                    findingHomeserver: false,
                });
            } else {
                console.warn("Unknown state for m.homeserver in discovery response: ", discovery);
                this.setState({
                    discoveredHsUrl: "",
                    discoveredIsUrl: "",
                    discoveryError: _t("Unknown failure discovering homeserver"),
                    findingHomeserver: false,
                });
            }
        } catch (e) {
            console.error(e);
            this.setState({
                findingHomeserver: false,
                discoveryError: _t("Unknown error discovering homeserver"),
            });
        }
    },

    _initLoginLogic: function(hsUrl, isUrl) {
        const self = this;
        hsUrl = hsUrl || this.state.enteredHomeserverUrl;
        isUrl = isUrl || this.state.enteredIdentityServerUrl;

        const fallbackHsUrl = hsUrl === this.props.defaultHsUrl ? this.props.fallbackHsUrl : null;

        const loginLogic = new Login(hsUrl, isUrl, fallbackHsUrl, {
            defaultDeviceDisplayName: this.props.defaultDeviceDisplayName,
        });
        this._loginLogic = loginLogic;

        this.setState({
            enteredHomeserverUrl: hsUrl,
            enteredIdentityServerUrl: isUrl,
            busy: true,
            loginIncorrect: false,
        });

        loginLogic.getFlows().then((flows) => {
            // look for a flow where we understand all of the steps.
            for (let i = 0; i < flows.length; i++ ) {
                if (!this._isSupportedFlow(flows[i])) {
                    continue;
                }

                // we just pick the first flow where we support all the
                // steps. (we don't have a UI for multiple logins so let's skip
                // that for now).
                loginLogic.chooseFlow(i);
                this.setState({
                    currentFlow: this._getCurrentFlowStep(),
                });
                return;
            }
            // we got to the end of the list without finding a suitable
            // flow.
            this.setState({
                errorText: _t(
                    "This homeserver doesn't offer any login flows which are " +
                        "supported by this client.",
                ),
            });
        }, function(err) {
            self.setState({
                errorText: self._errorTextFromError(err),
                loginIncorrect: false,
            });
        }).finally(function() {
            self.setState({
                busy: false,
            });
        }).done();
    },

    _isSupportedFlow: function(flow) {
        // technically the flow can have multiple steps, but no one does this
        // for login and loginLogic doesn't support it so we can ignore it.
        if (!this._stepRendererMap[flow.type]) {
            console.log("Skipping flow", flow, "due to unsupported login type", flow.type);
            return false;
        }
        return true;
    },

    _getCurrentFlowStep: function() {
        return this._loginLogic ? this._loginLogic.getCurrentFlowStep() : null;
    },

    _errorTextFromError(err) {
        let errCode = err.errcode;
        if (!errCode && err.httpStatus) {
            errCode = "HTTP " + err.httpStatus;
        }

        let errorText = _t("Error: Problem communicating with the given homeserver.") +
                (errCode ? " (" + errCode + ")" : "");

        if (err.cors === 'rejected') {
            if (window.location.protocol === 'https:' &&
                (this.state.enteredHomeserverUrl.startsWith("http:") ||
                 !this.state.enteredHomeserverUrl.startsWith("http"))
            ) {
                errorText = <span>
                    { _t("Can't connect to homeserver via HTTP when an HTTPS URL is in your browser bar. " +
                        "Either use HTTPS or <a>enable unsafe scripts</a>.", {},
                        {
                            'a': (sub) => {
                                return <a target="_blank" rel="noopener"
                                    href="https://www.google.com/search?&q=enable%20unsafe%20scripts"
                                >
                                    { sub }
                                </a>;
                            },
                        },
                    ) }
                </span>;
            } else {
                errorText = <span>
                    { _t("Can't connect to homeserver - please check your connectivity, ensure your " +
                        "<a>homeserver's SSL certificate</a> is trusted, and that a browser extension " +
                        "is not blocking requests.", {},
                        {
                            'a': (sub) => {
                                return <a target="_blank" rel="noopener"
                                    href={this.state.enteredHomeserverUrl}
                                >{ sub }</a>;
                            },
                        },
                    ) }
                </span>;
            }
        }

        return errorText;
    },

    renderServerComponentForStep() {
        const ServerTypeSelector = sdk.getComponent("auth.ServerTypeSelector");
        const ServerConfig = sdk.getComponent("auth.ServerConfig");
        const ModularServerConfig = sdk.getComponent("auth.ModularServerConfig");
        const AccessibleButton = sdk.getComponent("elements.AccessibleButton");

        // TODO: May need to adjust the behavior of this config option
        if (SdkConfig.get()['disable_custom_urls']) {
            return null;
        }

        // If we're on a different phase, we only show the server type selector,
        // which is always shown if we allow custom URLs at all.
        if (PHASES_ENABLED && this.state.phase !== PHASE_SERVER_DETAILS) {
            return <div>
                <ServerTypeSelector
                    defaultHsUrl={this.props.defaultHsUrl}
                    onChange={this.onServerTypeChange}
                />
            </div>;
        }

        let serverDetails = null;
        switch (this.state.serverType) {
            case ServerType.FREE:
                break;
            case ServerType.PREMIUM:
                serverDetails = <ModularServerConfig
                    customHsUrl={this.state.discoveredHsUrl || this.props.customHsUrl}
                    defaultHsUrl={this.props.defaultHsUrl}
                    defaultIsUrl={this.props.defaultIsUrl}
                    onServerConfigChange={this.onServerConfigChange}
                    delayTimeMs={250}
                />;
                break;
            case ServerType.ADVANCED:
                serverDetails = <ServerConfig
                    customHsUrl={this.state.discoveredHsUrl || this.props.customHsUrl}
                    customIsUrl={this.state.discoveredIsUrl || this.props.customIsUrl}
                    defaultHsUrl={this.props.defaultHsUrl}
                    defaultIsUrl={this.props.defaultIsUrl}
                    onServerConfigChange={this.onServerConfigChange}
                    delayTimeMs={250}
                />;
                break;
        }

        let nextButton = null;
        if (PHASES_ENABLED) {
            nextButton = <AccessibleButton className="mx_Login_submit"
                onClick={this.onServerDetailsNextPhaseClick}
            >
                {_t("Next")}
            </AccessibleButton>;
        }

        return <div>
            <ServerTypeSelector
                defaultHsUrl={this.props.defaultHsUrl}
                onChange={this.onServerTypeChange}
            />
            {serverDetails}
            {nextButton}
        </div>;
    },

    renderLoginComponentForStep() {
        if (PHASES_ENABLED && this.state.phase !== PHASE_LOGIN) {
            return null;
        }

        const step = this.state.currentFlow;

        if (!step) {
            return null;
        }

        const stepRenderer = this._stepRendererMap[step];

        if (stepRenderer) {
            return stepRenderer();
        }

        return null;
    },

    _renderPasswordStep: function() {
        const PasswordLogin = sdk.getComponent('auth.PasswordLogin');
        let onEditServerDetailsClick = null;
        // If custom URLs are allowed and we haven't selected the Free server type, wire
        // up the server details edit link.
        if (
            PHASES_ENABLED &&
            !SdkConfig.get()['disable_custom_urls'] &&
            this.state.serverType !== ServerType.FREE
        ) {
            onEditServerDetailsClick = this.onEditServerDetailsClick;
        }
        return (
            <PasswordLogin
               onSubmit={this.onPasswordLogin}
               onError={this.onPasswordLoginError}
               onEditServerDetailsClick={onEditServerDetailsClick}
               initialUsername={this.state.username}
               initialPhoneCountry={this.state.phoneCountry}
               initialPhoneNumber={this.state.phoneNumber}
               onUsernameChanged={this.onUsernameChanged}
               onUsernameBlur={this.onUsernameBlur}
               onPhoneCountryChanged={this.onPhoneCountryChanged}
               onPhoneNumberChanged={this.onPhoneNumberChanged}
               onForgotPasswordClick={this.props.onForgotPasswordClick}
               loginIncorrect={this.state.loginIncorrect}
               hsUrl={this.state.enteredHomeserverUrl}
               disableSubmit={this.state.findingHomeserver}
               />
        );
    },

    _renderSsoStep: function(url) {
        // XXX: This link does *not* have a target="_blank" because single sign-on relies on
        // redirecting the user back to a URI once they're logged in. On the web, this means
        // we use the same window and redirect back to riot. On electron, this actually
        // opens the SSO page in the electron app itself due to
        // https://github.com/electron/electron/issues/8841 and so happens to work.
        // If this bug gets fixed, it will break SSO since it will open the SSO page in the
        // user's browser, let them log into their SSO provider, then redirect their browser
        // to vector://vector which, of course, will not work.
        return (
            <a href={url} className="mx_Login_sso_link mx_Login_submit">{ _t('Sign in with single sign-on') }</a>
        );
    },

    render: function() {
        const Loader = sdk.getComponent("elements.Spinner");
        const AuthPage = sdk.getComponent("auth.AuthPage");
        const AuthHeader = sdk.getComponent("auth.AuthHeader");
        const AuthBody = sdk.getComponent("auth.AuthBody");
        const loader = this.state.busy ? <div className="mx_Login_loader"><Loader /></div> : null;

        const errorText = this.props.defaultServerDiscoveryError || this.state.discoveryError || this.state.errorText;

        let loginAsGuestJsx;
        if (this.props.enableGuest) {
            loginAsGuestJsx =
                <a className="mx_Auth_changeFlow" onClick={this._onLoginAsGuestClick} href="#">
                    { _t('Try the app first') }
                </a>;
        }

        let errorTextSection;
        if (errorText) {
            errorTextSection = (
                <div className="mx_Login_error">
                    { errorText }
                </div>
            );
        }

        return (
            <AuthPage>
                <AuthHeader />
                <AuthBody>
                    <h2>
                        {_t('Sign in to your account')}
                        {loader}
                    </h2>
                    { errorTextSection }
                    { this.renderServerComponentForStep() }
                    { this.renderLoginComponentForStep() }
                    <a className="mx_Auth_changeFlow" onClick={this.onRegisterClick} href="#">
                        { _t('Create account') }
                    </a>
                    { loginAsGuestJsx }
                </AuthBody>
            </AuthPage>
        );
    },
});
