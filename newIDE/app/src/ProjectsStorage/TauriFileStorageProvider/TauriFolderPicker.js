// @flow
import { Trans, t } from '@lingui/macro';
import { I18n } from '@lingui/react';
import { type I18n as I18nType } from '@lingui/core';
import * as React from 'react';
import TextField from '../../UI/TextField';
import FlatButton from '../../UI/FlatButton';
import TauriBridge from '../../Utils/Tauri/TauriBridge';

/**
 * Tauri equivalent of UI/LocalFolderPicker/index.js: a folder picker using
 * `TauriBridge.showOpenDialog({ directory: true })` instead of the Electron
 * `@electron/remote` dialog.
 */

const styles = {
  container: {
    position: 'relative',
    display: 'flex',
    alignItems: 'baseline',
  },
  button: {
    marginLeft: 10,
  },
  textField: {
    flex: 1,
  },
};

type Props = {|
  type: 'export' | 'create-game' | 'default-workspace',
  value: string,
  onChange: string => void,
  defaultPath?: string,
  fullWidth?: boolean,
|};

type TitleAndMessage = {|
  title: string,
|};

const TauriFolderPicker = ({
  type,
  value,
  onChange,
  defaultPath,
  fullWidth,
}: Props): React.Node => {
  // Use an internal state to avoid validating the value when the user
  // is typing in the text field. This allows typing a "/" without the
  // formatting kicking in.
  const [textValue, setTextValue] = React.useState(value);
  const onChooseFolder = async ({ title }: TitleAndMessage) => {
    const filePaths = await TauriBridge.showOpenDialog({
      title,
      directory: true,
      defaultPath,
    });

    if (!filePaths || !filePaths.length) return;

    const filePath = filePaths[0];
    onChange(filePath);
    setTextValue(filePath);
  };

  const onBlur = () => {
    onChange(textValue);
  };

  const getTitleAndMessage = (i18n: I18nType): TitleAndMessage => {
    if (type === 'export') {
      return { title: i18n._(t`Choose an export folder`) };
    }
    if (type === 'default-workspace') {
      return { title: i18n._(t`Choose a workspace folder`) };
    }
    return { title: i18n._(t`Choose a folder for the new game`) };
  };

  return (
    <I18n>
      {({ i18n }) => {
        const titleAndMessage = getTitleAndMessage(i18n);
        return (
          <div
            style={{
              ...styles.container,
              width: fullWidth ? '100%' : undefined,
            }}
          >
            {/* $FlowFixMe[incompatible-type] */}
            <TextField
              margin="dense"
              style={styles.textField}
              type="text"
              hintText={titleAndMessage.title}
              value={textValue}
              onChange={(event, value) => setTextValue(value)}
              onBlur={onBlur}
            />
            <FlatButton
              label={<Trans>Choose folder</Trans>}
              // $FlowFixMe[incompatible-type]
              style={styles.button}
              onClick={() => onChooseFolder(titleAndMessage)}
            />
          </div>
        );
      }}
    </I18n>
  );
};

export default TauriFolderPicker;
