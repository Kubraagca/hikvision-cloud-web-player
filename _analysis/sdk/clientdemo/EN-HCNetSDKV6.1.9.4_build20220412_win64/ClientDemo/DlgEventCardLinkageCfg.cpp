// DlgEventCardLinkageCfg.cpp : implementation file
//

#include "stdafx.h"
#include "clientdemo.h"
#include "DlgEventCardLinkageCfg.h"

#ifdef _DEBUG
#define new DEBUG_NEW
#undef THIS_FILE
static char THIS_FILE[] = __FILE__;
#endif

/////////////////////////////////////////////////////////////////////////////
// DlgEventCardLinkageCfg dialog


DlgEventCardLinkageCfg::DlgEventCardLinkageCfg(CWnd* pParent /*=NULL*/)
	: CDialog(DlgEventCardLinkageCfg::IDD, pParent)
    , m_iLocalController(0)
    , m_dwEventID(1)
{
	//{{AFX_DATA_INIT(DlgEventCardLinkageCfg)
    m_byProMode = FALSE;
    m_byEmployeeNo = FALSE;
    m_byMacAddr = FALSE;
    byMainDevBuzzer = FALSE;
    m_sCardNo = _T("");
    m_sEmployeeNo = _T("");
    m_sMacAddr = _T("");
    m_dwEventSourceID = 0;
	m_bLinkCapPic = FALSE;
    m_bLinkRecordVideo = FALSE;
    m_bMainDevStopBuzzer = FALSE;
    m_dwAudioDisplayID = 0;
	//}}AFX_DATA_INIT
    memset(&m_struEventCardLinkageCfgV51, 0, sizeof(m_struEventCardLinkageCfgV51));
    m_struEventCardLinkageCfgV51.dwSize = sizeof(m_struEventCardLinkageCfgV51);
    memset(&m_struEventCardLinkageCond, 0, sizeof(m_struEventCardLinkageCond));
    m_struEventCardLinkageCond.dwSize = sizeof(m_struEventCardLinkageCond);
}


void DlgEventCardLinkageCfg::DoDataExchange(CDataExchange* pDX)
{
	CDialog::DoDataExchange(pDX);
	//{{AFX_DATA_MAP(DlgEventCardLinkageCfg)
    DDX_Control(pDX, IDC_TREE_OPENDOOR, m_treeDoorOpen);
    DDX_Control(pDX, IDC_TREE_CLOSEDOOR, m_treeDoorClose);
    DDX_Control(pDX, IDC_TREE_READERBUZZER, m_treeCardReaderBuzzer);
    DDX_Control(pDX, IDC_TREE_READER_STOP_BUZZER, m_treeCardReaderStopBuzzer);
    DDX_Control(pDX, IDC_TREE_ALARMOUT, m_treeAlarmOut);
    DDX_Control(pDX, IDC_TREE_NORMALOPEN, m_treeNormalOpen);
    DDX_Control(pDX, IDC_TREE_NORMALCLOSE, m_treeNormalClose);
	DDX_Check(pDX, IDC_CHECK_PROMODE, m_byProMode);
    DDX_Check(pDX, IDC_CHECK_EMPLOYEE_NO, m_byEmployeeNo);
    DDX_Check(pDX, IDC_CHECK_MAC_ADDR, m_byMacAddr);
    DDX_Check(pDX, IDC_CHECK_BUZZER, byMainDevBuzzer);
    DDX_Control(pDX, IDC_COMBO_MAIN_TYPE, m_comboMainEventType);
    DDX_Control(pDX, IDC_COMBO_OTHER_TYPE, m_comboSubEventType);
	DDX_Text(pDX, IDC_EDIT_CARD, m_sCardNo);
    DDX_Text(pDX, IDC_EDIT_EMPLOYEE_NO, m_sEmployeeNo);
    DDX_Text(pDX, IDC_EDIT_MAC_ADDR, m_sMacAddr);
    DDX_Text(pDX, IDC_EDIT_EVENT_ID, m_dwEventSourceID);
	DDX_Check(pDX, IDC_CHK_LINKAGE_CAP_PIC, m_bLinkCapPic);
    DDX_Check(pDX, IDC_CHK_LINKAGE_RECORD_VIDEO, m_bLinkRecordVideo);
    DDX_Check(pDX, IDC_CHK_MAIN_DEV_STOP_BUZZER, m_bMainDevStopBuzzer);
	//}}AFX_DATA_MAP
    DDX_Text(pDX, IDC_EDIT_LOCAL_CONTROLLER, m_iLocalController);
    DDX_Control(pDX, IDC_TREE_ALARM_OUT_CLOSE, m_treeAlarmOutClose);
    DDX_Control(pDX, IDC_TREE_ALARM_IN_SETUP, m_treeAlarmInSetup);
    DDX_Control(pDX, IDC_TREE_ALARM_IN_CLOSE, m_treeAlarmInClose);
    DDX_Text(pDX, IDC_EDIT_EVENT, m_dwEventID);
    DDV_MinMaxUInt(pDX, m_dwEventID, 1, 500);
    DDX_Text(pDX, IDC_EDIT_AUDIO_DISPLAY_ID, m_dwAudioDisplayID);
    DDX_Control(pDX, IDC_CMB_AUDIO_DISPLAY_MODE, m_cmbAudioDisplayMode);
}


BEGIN_MESSAGE_MAP(DlgEventCardLinkageCfg, CDialog)
	//{{AFX_MSG_MAP(DlgEventCardLinkageCfg)
    ON_BN_CLICKED(IDC_BUTTON_SET, OnBtnSet)
    ON_BN_CLICKED(IDC_BUTTON_GET, OnBtnGet)
    ON_NOTIFY(NM_CLICK, IDC_TREE_READERBUZZER, OnClickTreeCardReaderBuzzer)
    ON_NOTIFY(NM_CLICK, IDC_TREE_ALARMOUT, OnClickTreeAlarmOut)
    ON_NOTIFY(NM_CLICK, IDC_TREE_OPENDOOR, OnClickTreeDoorOpen)
	ON_NOTIFY(NM_CLICK, IDC_TREE_CLOSEDOOR, OnClickTreeDoorClose)
    ON_NOTIFY(NM_CLICK, IDC_TREE_NORMALOPEN, OnClickTreeNormalOpen)
	ON_NOTIFY(NM_CLICK, IDC_TREE_NORMALCLOSE, OnClickTreeNormalClose)
    ON_CBN_SELCHANGE(IDC_COMBO_MAIN_TYPE, OnSelchangeEventMainType)
	//}}AFX_MSG_MAP
    ON_NOTIFY(NM_CLICK, IDC_TREE_ALARM_OUT_CLOSE, &DlgEventCardLinkageCfg::OnNMClickTreeAlarmOutClose)
    ON_NOTIFY(NM_CLICK, IDC_TREE_ALARM_IN_SETUP, &DlgEventCardLinkageCfg::OnNMClickTreeAlarmInSetup)
    ON_NOTIFY(NM_CLICK, IDC_TREE_ALARM_IN_CLOSE, &DlgEventCardLinkageCfg::OnNMClickTreeAlarmInClose)
    ON_NOTIFY(NM_CLICK, IDC_TREE_READER_STOP_BUZZER, &DlgEventCardLinkageCfg::OnClickTreeReaderStopBuzzer)
END_MESSAGE_MAP()

/////////////////////////////////////////////////////////////////////////////
// DlgEventCardLinkageCfg message handlers

BOOL DlgEventCardLinkageCfg::OnInitDialog() 
{
	CDialog::OnInitDialog();
	
	// TODO: Add extra initialization here
    m_iDeviceIndex = g_pMainDlg->GetCurDeviceIndex();
    m_lUserID = g_struDeviceInfo[m_iDeviceIndex].lLoginID;
    
    InitMainEventType();
    SubEventTypeDev();
    CreateTree();
    m_cmbAudioDisplayMode.SetCurSel(0);
    return TRUE;  // return TRUE unless you set the focus to a control
	              // EXCEPTION: OCX Property Pages should return FALSE
}

void DlgEventCardLinkageCfg::OnBtnSet() 
{
	// TODO: Add your control notification handler code here
	UpdateData(TRUE);
	GetTreeSel(); 
    char szLan[1024];
    m_struEventCardLinkageCfgV51.byCapturePic = m_bLinkCapPic;
    m_struEventCardLinkageCfgV51.byRecordVideo = m_bLinkRecordVideo;
    m_struEventCardLinkageCfgV51.byMainDevStopBuzzer = m_bMainDevStopBuzzer;
    m_struEventCardLinkageCfgV51.wAudioDisplayID = (WORD)m_dwAudioDisplayID;
    m_struEventCardLinkageCfgV51.byAudioDisplayMode = m_cmbAudioDisplayMode.GetCurSel();
    DWORD dwStatus = 0;
    m_struEventCardLinkageCond.dwEventID = m_dwEventID;
    m_struEventCardLinkageCond.wLocalControllerID = m_iLocalController;
    if (!NET_DVR_SetDeviceConfig(m_lUserID, NET_DVR_SET_EVENT_CARD_LINKAGE_CFG_V51, 1, &m_struEventCardLinkageCond, sizeof(m_struEventCardLinkageCond), &dwStatus, &m_struEventCardLinkageCfgV51, sizeof(m_struEventCardLinkageCfgV51)))
    {
        g_pMainDlg->AddLog(m_iDeviceIndex, OPERATION_FAIL_T, "NET_DVR_SET_EVENT_CARD_LINKAGE_CFG_V51 Failed");
        g_StringLanType(szLan, "设置事件或卡号联动参数配置失败", "Set event card linkage cfg Failed");
        MessageBox(szLan);
    }
    else
    {
        g_pMainDlg->AddLog(m_iDeviceIndex, OPERATION_SUCC_T, "NET_DVR_SET_EVENT_CARD_LINKAGE_CFG_V51 SUCC");
    }
}

void DlgEventCardLinkageCfg::OnBtnGet() 
{
	// TODO: Add your control notification handler code here
    UpdateData(TRUE);
    DWORD dwReturned = 0;
    char szLan[1024];
    DWORD dwStatus = 0;
    m_struEventCardLinkageCond.dwEventID = m_dwEventID;
    m_struEventCardLinkageCond.wLocalControllerID = m_iLocalController;
    if (!NET_DVR_GetDeviceConfig(m_lUserID, NET_DVR_GET_EVENT_CARD_LINKAGE_CFG_V51, 1, &m_struEventCardLinkageCond, sizeof(m_struEventCardLinkageCond), &dwStatus, &m_struEventCardLinkageCfgV51, sizeof(m_struEventCardLinkageCfgV51)))
    {
        g_pMainDlg->AddLog(m_iDeviceIndex, OPERATION_FAIL_T, "NET_DVR_GET_EVENT_CARD_LINKAGE_CFG_V51 Failed");
        g_StringLanType(szLan, "获取事件或卡号联动参数配置失败", "Get event card linkage cfg Failed");
        MessageBox(szLan);
    }
    else
    {
        g_pMainDlg->AddLog(m_iDeviceIndex, OPERATION_SUCC_T, "NET_DVR_GET_EVENT_CARD_LINKAGE_CFG_V51 SUCC");
        if (m_struEventCardLinkageCfgV51.byProMode == 1)
        {
            m_byProMode = TRUE;
        }
        if (m_struEventCardLinkageCfgV51.byProMode == 2)
        {
            m_byMacAddr = TRUE;
        }
        if (m_struEventCardLinkageCfgV51.byProMode == 3)
        {
            m_byEmployeeNo = TRUE;
        }
        m_dwEventSourceID = m_struEventCardLinkageCfgV51.dwEventSourceID;
        byMainDevBuzzer = m_struEventCardLinkageCfgV51.byMainDevBuzzer;
        m_bLinkCapPic = m_struEventCardLinkageCfgV51.byCapturePic;
        m_bLinkRecordVideo = m_struEventCardLinkageCfgV51.byRecordVideo;
        m_bMainDevStopBuzzer = m_struEventCardLinkageCfgV51.byMainDevStopBuzzer;
        m_dwAudioDisplayID = m_struEventCardLinkageCfgV51.wAudioDisplayID;
        m_cmbAudioDisplayMode.SetCurSel(m_struEventCardLinkageCfgV51.byAudioDisplayMode);
        if (m_byProMode)
        {
            m_sCardNo.Format("%s", m_struEventCardLinkageCfgV51.uLinkageInfo.byCardNo);
        }
        if (m_byMacAddr)
        {
            m_sMacAddr.Format("%02X:%02X:%02X:%02X:%02X:%02X", m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[0], m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[1], \
                m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[2], m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[3], m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[4], \
                m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr[5]);
        }
        if (m_byEmployeeNo)
        {
            m_sEmployeeNo.Format("%s", m_struEventCardLinkageCfgV51.uLinkageInfo.byEmployeeNo);
        }
        if (m_byProMode == FALSE && m_byMacAddr == FALSE && m_byEmployeeNo == FALSE)
        {
            m_comboMainEventType.SetCurSel(m_struEventCardLinkageCfgV51.uLinkageInfo.struEventLinkage.wMainEventType);

            DWORD dwMainEventType = m_comboMainEventType.GetCurSel();
            if (dwMainEventType == 0)
            {
                SubEventTypeDev();
            }
            else if (dwMainEventType == 1)
            {
                SubEventTypeAlarm();
            }
            else if (dwMainEventType == 2)
            {
                SubEventTypeDoor();
            }
            else if (dwMainEventType == 3)
            {
                SubEventTypeCardReader();
            }

            m_comboSubEventType.SetCurSel(m_struEventCardLinkageCfgV51.uLinkageInfo.struEventLinkage.wSubEventType);
        }
        UpdateData(FALSE);
        CreateTree();
    }
}

void DlgEventCardLinkageCfg::OnSelchangeEventMainType() 
{
    // TODO: Add your control notification handler code here
    UpdateData(TRUE);
    DWORD dwMainEventType = m_comboMainEventType.GetCurSel();
    if (dwMainEventType == 0)
    {
        SubEventTypeDev();
    } 
    else if (dwMainEventType == 1)
    {
        SubEventTypeAlarm();
    }
    else if (dwMainEventType == 2)
    {
        SubEventTypeDoor();
    }
    else if (dwMainEventType == 3)
    {
        SubEventTypeCardReader();
    }

    UpdateData(FALSE);
}

void DlgEventCardLinkageCfg::CreateTree()
{
    CString strTemp =_T("");
    CString strChanTmp = _T("");
    int i = 0;
    m_treeCardReaderBuzzer.DeleteAllItems();
    m_treeCardReaderStopBuzzer.DeleteAllItems();
    m_treeAlarmOut.DeleteAllItems();
    
    HTREEITEM hChanItem = NULL;
    HTREEITEM hFirstItem = NULL;
       
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byReaderBuzzer); i++)
    {
        strTemp.Format("Buzzer %d", i + 1);
        hChanItem = m_treeCardReaderBuzzer.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeCardReaderBuzzer.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byReaderBuzzer[i])
        {
            m_treeCardReaderBuzzer.SetCheck(hChanItem, TRUE);
        }
    }

    m_treeCardReaderBuzzer.SelectItem(hFirstItem);
    m_treeCardReaderBuzzer.Expand(m_treeCardReaderBuzzer.GetRootItem(), TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;

    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byReaderStopBuzzer); i++)
    {
        strTemp.Format("Buzzer %d", i + 1);
        hChanItem = m_treeCardReaderStopBuzzer.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeCardReaderStopBuzzer.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byReaderStopBuzzer[i])
        {
            m_treeCardReaderStopBuzzer.SetCheck(hChanItem, TRUE);
        }
    }

    m_treeCardReaderStopBuzzer.SelectItem(hFirstItem);
    m_treeCardReaderStopBuzzer.Expand(m_treeCardReaderStopBuzzer.GetRootItem(), TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;

    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byAlarmout); i++)
    {
        strTemp.Format("AlarmOut %d", i + 1);
        hChanItem = m_treeAlarmOut.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeAlarmOut.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byAlarmout[i])
        {
            m_treeAlarmOut.SetCheck(hChanItem, TRUE);
        }
    }

    m_treeAlarmOut.SelectItem(hFirstItem);
	m_treeAlarmOut.Expand(m_treeAlarmOut.GetRootItem(),TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeDoorOpen.DeleteAllItems();    
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byOpenDoor); i++)
    {
        strTemp.Format("Door %d", i + 1);
        hChanItem = m_treeDoorOpen.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }
        
        m_treeDoorOpen.SetItemData(hChanItem, i);
        
        if (m_struEventCardLinkageCfgV51.byOpenDoor[i])
        {
            m_treeDoorOpen.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeDoorOpen.SelectItem(hFirstItem);
	m_treeDoorOpen.Expand(m_treeDoorOpen.GetRootItem(),TVE_EXPAND);


    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeDoorClose.DeleteAllItems();
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byCloseDoor); i++)
    {
        strTemp.Format("Door %d", i + 1);
        hChanItem = m_treeDoorClose.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }      
        m_treeDoorClose.SetItemData(hChanItem, i);
        
        if (m_struEventCardLinkageCfgV51.byCloseDoor[i])
        {
            m_treeDoorClose.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeDoorClose.SelectItem(hFirstItem);
	m_treeDoorClose.Expand(m_treeDoorClose.GetRootItem(),TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeNormalOpen.DeleteAllItems();    
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byNormalOpen); i++)
    {
        strTemp.Format("Door %d", i + 1);
        hChanItem = m_treeNormalOpen.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }
        
        m_treeNormalOpen.SetItemData(hChanItem, i);
        
        if (m_struEventCardLinkageCfgV51.byNormalOpen[i])
        {
            m_treeNormalOpen.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeNormalOpen.SelectItem(hFirstItem);
	m_treeNormalOpen.Expand(m_treeNormalOpen.GetRootItem(),TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeNormalClose.DeleteAllItems();    
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byNormalClose); i++)
    {
        strTemp.Format("Door %d", i + 1);
        hChanItem = m_treeNormalClose.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }
        
        m_treeNormalClose.SetItemData(hChanItem, i);
        
        if (m_struEventCardLinkageCfgV51.byNormalClose[i])
        {
            m_treeNormalClose.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeNormalClose.SelectItem(hFirstItem);
    m_treeNormalClose.Expand(m_treeNormalClose.GetRootItem(),TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeAlarmOutClose.DeleteAllItems();
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byAlarmOutClose); i++)
    {
        strTemp.Format("AlarmOut %d", i + 1);
        hChanItem = m_treeAlarmOutClose.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeAlarmOutClose.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byAlarmOutClose[i])
        {
            m_treeAlarmOutClose.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeAlarmOutClose.SelectItem(hFirstItem);
    m_treeAlarmOutClose.Expand(m_treeAlarmOutClose.GetRootItem(), TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeAlarmInSetup.DeleteAllItems();
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byAlarmInSetup); i++)
    {
        strTemp.Format("AlarmIn %d", i + 1);
        hChanItem = m_treeAlarmInSetup.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeAlarmInSetup.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byAlarmInSetup[i])
        {
            m_treeAlarmInSetup.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeAlarmInSetup.SelectItem(hFirstItem);
    m_treeAlarmInSetup.Expand(m_treeAlarmInSetup.GetRootItem(), TVE_EXPAND);

    hChanItem = NULL;
    hFirstItem = NULL;
    m_treeAlarmInClose.DeleteAllItems();
    for (i = 0; i < sizeof(m_struEventCardLinkageCfgV51.byAlarmInClose); i++)
    {
        strTemp.Format("AlarmIn %d", i + 1);
        hChanItem = m_treeAlarmInClose.InsertItem(strTemp, 0, 0, TVI_ROOT);
        if (hFirstItem == NULL)
        {
            hFirstItem = hChanItem;
        }

        m_treeAlarmInClose.SetItemData(hChanItem, i);

        if (m_struEventCardLinkageCfgV51.byAlarmInClose[i])
        {
            m_treeAlarmInClose.SetCheck(hChanItem, TRUE);
        }
    }
    m_treeAlarmInClose.SelectItem(hFirstItem);
    m_treeAlarmInClose.Expand(m_treeAlarmInClose.GetRootItem(), TVE_EXPAND);
}

void DlgEventCardLinkageCfg::GetTreeSel()
{
	UpdateData(TRUE); 
	memset(&m_struEventCardLinkageCfgV51, 0 , sizeof(m_struEventCardLinkageCfgV51));
	m_struEventCardLinkageCfgV51.dwSize = sizeof(m_struEventCardLinkageCfgV51);
    if (m_byProMode == TRUE)
    {
        m_struEventCardLinkageCfgV51.byProMode = 1;
    }
    if (m_byMacAddr == TRUE)
    {
        m_struEventCardLinkageCfgV51.byProMode = 2;
    }
    if (m_byEmployeeNo == TRUE)
    {
        m_struEventCardLinkageCfgV51.byProMode = 3;
    }
    if (m_byProMode == FALSE && m_byMacAddr == FALSE && m_byEmployeeNo == FALSE)
    {
        m_struEventCardLinkageCfgV51.byProMode = 0;
    }
	m_struEventCardLinkageCfgV51.dwEventSourceID = m_dwEventSourceID;
    m_struEventCardLinkageCfgV51.byMainDevBuzzer = byMainDevBuzzer;
    if (m_struEventCardLinkageCfgV51.byProMode == 1)
    {
        memcpy(m_struEventCardLinkageCfgV51.uLinkageInfo.byCardNo, m_sCardNo, m_sCardNo.GetLength());
    }
    if (m_struEventCardLinkageCfgV51.byProMode == 2)
    {
        char sMac[32] = { 0 };
        int iLen = m_sMacAddr.GetLength();
        memcpy(sMac, m_sMacAddr, iLen);
        StrToMac(sMac, m_struEventCardLinkageCfgV51.uLinkageInfo.byMACAddr);
    }
    if (m_struEventCardLinkageCfgV51.byProMode == 3)
    {
        memcpy(m_struEventCardLinkageCfgV51.uLinkageInfo.byEmployeeNo, m_sEmployeeNo, m_sEmployeeNo.GetLength());
    }
    if (m_struEventCardLinkageCfgV51.byProMode == 0)
    {
        m_struEventCardLinkageCfgV51.uLinkageInfo.struEventLinkage.wMainEventType = m_comboMainEventType.GetCurSel();
        m_struEventCardLinkageCfgV51.uLinkageInfo.struEventLinkage.wSubEventType = m_comboSubEventType.GetCurSel();
    }

    int i = 0; 
	HTREEITEM hTreeItem;

	BOOL bCheck;
	DWORD dwIndex;
	DWORD dwCount = 0; 
	CTreeCtrl *treeCtr = &m_treeAlarmOut; 
    dwCount = m_treeAlarmOut.GetCount(); 
	hTreeItem = m_treeAlarmOut.GetRootItem();

    for ( i=0; i<dwCount; i++)
    {
		bCheck = treeCtr->GetCheck(hTreeItem);
		dwIndex = treeCtr->GetItemData(hTreeItem);
		m_struEventCardLinkageCfgV51.byAlarmout[dwIndex] = bCheck;
		hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

	treeCtr = &m_treeCardReaderBuzzer;
	hTreeItem = m_treeCardReaderBuzzer.GetRootItem();
	dwCount = m_treeCardReaderBuzzer.GetCount(); 
    for ( i=0; i<dwCount; i++)
    {
		bCheck = treeCtr->GetCheck(hTreeItem);
		dwIndex = treeCtr->GetItemData(hTreeItem);
		m_struEventCardLinkageCfgV51.byReaderBuzzer[dwIndex] = bCheck;
		hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

    treeCtr = &m_treeCardReaderStopBuzzer;
    hTreeItem = m_treeCardReaderStopBuzzer.GetRootItem();
    dwCount = m_treeCardReaderStopBuzzer.GetCount();
    for (i = 0; i < dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byReaderStopBuzzer[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem);
    }

	treeCtr = &m_treeDoorOpen;
	hTreeItem = m_treeDoorOpen.GetRootItem();
	dwCount = m_treeDoorOpen.GetCount(); 
    for ( i=0; i<dwCount; i++)
    {
		bCheck = treeCtr->GetCheck(hTreeItem);
		dwIndex = treeCtr->GetItemData(hTreeItem);
		m_struEventCardLinkageCfgV51.byOpenDoor[dwIndex] = bCheck;
		hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

	treeCtr = &m_treeDoorClose;
	hTreeItem = m_treeDoorClose.GetRootItem();
	dwCount = m_treeDoorClose.GetCount(); 
    for ( i=0; i<dwCount; i++)
    {
		bCheck = treeCtr->GetCheck(hTreeItem);
		dwIndex = treeCtr->GetItemData(hTreeItem);
		m_struEventCardLinkageCfgV51.byCloseDoor[dwIndex] = bCheck;
		hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

    treeCtr = &m_treeNormalOpen;
    hTreeItem = m_treeNormalOpen.GetRootItem();
    dwCount = m_treeNormalOpen.GetCount(); 
    for ( i=0; i<dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byNormalOpen[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

    treeCtr = &m_treeNormalClose;
    hTreeItem = m_treeNormalClose.GetRootItem();
    dwCount = m_treeNormalClose.GetCount(); 
    for ( i=0; i<dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byNormalClose[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem); 
    }

    treeCtr = &m_treeAlarmOutClose;
    hTreeItem = m_treeAlarmOutClose.GetRootItem();
    dwCount = m_treeAlarmOutClose.GetCount();
    for (i = 0; i < dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byAlarmOutClose[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem);
    }

    treeCtr = &m_treeAlarmInSetup;
    hTreeItem = m_treeAlarmInSetup.GetRootItem();
    dwCount = m_treeAlarmInSetup.GetCount();
    for (i = 0; i < dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byAlarmInSetup[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem);
    }

    treeCtr = &m_treeAlarmInClose;
    hTreeItem = m_treeAlarmInClose.GetRootItem();
    dwCount = m_treeAlarmInClose.GetCount();
    for (i = 0; i < dwCount; i++)
    {
        bCheck = treeCtr->GetCheck(hTreeItem);
        dwIndex = treeCtr->GetItemData(hTreeItem);
        m_struEventCardLinkageCfgV51.byAlarmInClose[dwIndex] = bCheck;
        hTreeItem = treeCtr->GetNextSiblingItem(hTreeItem);
    }
} 

void DlgEventCardLinkageCfg::OnClickTreeCardReaderBuzzer(NMHDR* pNMHDR, LRESULT* pResult) 
{
	// TODO: Add your control notification handler code here
    UpdateData(TRUE);

    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeCardReaderBuzzer.ScreenToClient(&pt);
    GetDlgItem(IDC_TREE_READERBUZZER)->GetWindowRect(&rc);
    m_treeCardReaderBuzzer.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;
    
    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeCardReaderBuzzer.HitTest(pt, &uFlag);
    
    if (NULL == hSelect) 
    {
        return;
    }
    m_treeCardReaderBuzzer.SelectItem(hSelect);
    DWORD dwIndex = m_treeCardReaderBuzzer.GetItemData(hSelect);
    BOOL bCheck = m_treeCardReaderBuzzer.GetCheck(hSelect);
    m_treeCardReaderBuzzer.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byReaderBuzzer[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM ||uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)//LVHT_TOLEFT)
    {
        m_treeCardReaderBuzzer.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byReaderBuzzer[dwIndex] = !bCheck;
    }
    else
    {
        m_treeCardReaderBuzzer.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byReaderBuzzer[dwIndex] = bCheck;
	}
    UpdateData(FALSE); 
	*pResult = 0;
}

void DlgEventCardLinkageCfg::OnClickTreeAlarmOut(NMHDR* pNMHDR, LRESULT* pResult) 
{
	// TODO: Add your control notification handler code here
    UpdateData(TRUE);
    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeAlarmOut.ScreenToClient(&pt);
    GetDlgItem(IDC_TREE_ALARMOUT)->GetWindowRect(&rc);
    m_treeAlarmOut.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;
    
    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeAlarmOut.HitTest(pt, &uFlag);
    
    if (NULL == hSelect) 
    {
        return;
    }
    m_treeAlarmOut.SelectItem(hSelect);
    DWORD dwIndex = m_treeAlarmOut.GetItemData(hSelect);
    BOOL bCheck = m_treeAlarmOut.GetCheck(hSelect);
    m_treeAlarmOut.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byAlarmout[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM ||uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeAlarmOut.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byAlarmout[dwIndex] = !bCheck;
    }
    else
    {
        m_treeAlarmOut.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byAlarmout[dwIndex] = bCheck;
	}
    UpdateData(FALSE);
	*pResult = 0;
}

void DlgEventCardLinkageCfg::OnClickTreeDoorOpen(NMHDR* pNMHDR, LRESULT* pResult) 
{
	// TODO: Add your control notification handler code here
	UpdateData(TRUE);
    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeDoorOpen.ScreenToClient(&pt);   
    m_treeDoorOpen.GetWindowRect(&rc);
    m_treeDoorOpen.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;
    
    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeDoorOpen.HitTest(pt, &uFlag);
    
    if (NULL == hSelect) 
    {
        return;
    }
    m_treeDoorOpen.SelectItem(hSelect);
    DWORD dwIndex = m_treeDoorOpen.GetItemData(hSelect);
    BOOL bCheck = m_treeDoorOpen.GetCheck(hSelect);
    m_treeDoorOpen.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byOpenDoor[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM ||uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
		m_treeDoorOpen.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byOpenDoor[dwIndex] = !bCheck;
    }
    else
    {
        m_treeDoorOpen.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byOpenDoor[dwIndex] = bCheck;
	}
    UpdateData(FALSE);
	*pResult = 0;
}

void DlgEventCardLinkageCfg::OnClickTreeDoorClose(NMHDR* pNMHDR, LRESULT* pResult) 
{
	// TODO: Add your control notification handler code here
    UpdateData(TRUE);
    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeDoorClose.ScreenToClient(&pt);
    m_treeDoorClose.GetWindowRect(&rc);
    m_treeDoorClose.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;

    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeDoorClose.HitTest(pt, &uFlag);

    if (NULL == hSelect) 
    {
        return;
    }
    m_treeDoorClose.SelectItem(hSelect);
    DWORD dwIndex = m_treeDoorClose.GetItemData(hSelect);
    BOOL bCheck = m_treeDoorClose.GetCheck(hSelect);
    m_treeDoorClose.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byCloseDoor[dwIndex] = !bCheck;

    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM ||uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL )
    {
        m_treeDoorClose.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byCloseDoor[dwIndex] = !bCheck;
    }
    else
    {
        m_treeDoorClose.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byCloseDoor[dwIndex] = bCheck;
    }	
    UpdateData(FALSE);
	*pResult = 0;
}

void DlgEventCardLinkageCfg::OnClickTreeNormalOpen(NMHDR* pNMHDR, LRESULT* pResult) 
{
    // TODO: Add your control notification handler code here
    UpdateData(TRUE);
    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeNormalOpen.ScreenToClient(&pt);   
    m_treeNormalOpen.GetWindowRect(&rc);
    m_treeNormalOpen.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;
    
    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeNormalOpen.HitTest(pt, &uFlag);
    
    if (NULL == hSelect) 
    {
        return;
    }
    m_treeNormalOpen.SelectItem(hSelect);
    DWORD dwIndex = m_treeNormalOpen.GetItemData(hSelect);
    BOOL bCheck = m_treeNormalOpen.GetCheck(hSelect);
    m_treeNormalOpen.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byNormalOpen[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM ||uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeNormalOpen.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byNormalOpen[dwIndex] = !bCheck;
    }
    else
    {
        m_treeNormalOpen.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byNormalOpen[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}

void DlgEventCardLinkageCfg::OnClickTreeNormalClose(NMHDR* pNMHDR, LRESULT* pResult) 
{
    // TODO: Add your control notification handler code here
    UpdateData(TRUE);
    CPoint pt(0,0);
    CRect rc(0,0,0,0);
    GetCursorPos(&pt);
    m_treeNormalClose.ScreenToClient(&pt);   
    m_treeNormalClose.GetWindowRect(&rc);
    m_treeNormalClose.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;
    
    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeNormalClose.HitTest(pt, &uFlag);
    
    if (NULL == hSelect) 
    {
        return;
    }
    m_treeNormalClose.SelectItem(hSelect);
    DWORD dwIndex = m_treeNormalClose.GetItemData(hSelect);
    BOOL bCheck = m_treeNormalClose.GetCheck(hSelect);
    m_treeNormalClose.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byNormalClose[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM || uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeNormalClose.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byNormalClose[dwIndex] = !bCheck;
    }
    else
    {
        m_treeNormalClose.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byNormalClose[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}

void DlgEventCardLinkageCfg::OnNMClickTreeAlarmOutClose(NMHDR *pNMHDR, LRESULT *pResult)
{
    // TODO:  在此添加控件通知处理程序代码
    UpdateData(TRUE);
    CPoint pt(0, 0);
    CRect rc(0, 0, 0, 0);
    GetCursorPos(&pt);
    m_treeAlarmOutClose.ScreenToClient(&pt);
    m_treeAlarmOutClose.GetWindowRect(&rc);
    m_treeAlarmOutClose.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;

    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeAlarmOutClose.HitTest(pt, &uFlag);

    if (NULL == hSelect)
    {
        return;
    }
    m_treeAlarmOutClose.SelectItem(hSelect);
    DWORD dwIndex = m_treeAlarmOutClose.GetItemData(hSelect);
    BOOL bCheck = m_treeAlarmOutClose.GetCheck(hSelect);
    m_treeAlarmOutClose.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byAlarmOutClose[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM || uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeAlarmOutClose.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byAlarmOutClose[dwIndex] = !bCheck;
    }
    else
    {
        m_treeAlarmOutClose.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byAlarmOutClose[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}


void DlgEventCardLinkageCfg::OnNMClickTreeAlarmInSetup(NMHDR *pNMHDR, LRESULT *pResult)
{
    // TODO:  在此添加控件通知处理程序代码
    UpdateData(TRUE);
    CPoint pt(0, 0);
    CRect rc(0, 0, 0, 0);
    GetCursorPos(&pt);
    m_treeAlarmInSetup.ScreenToClient(&pt);
    m_treeAlarmInSetup.GetWindowRect(&rc);
    m_treeAlarmInSetup.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;

    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeAlarmInSetup.HitTest(pt, &uFlag);

    if (NULL == hSelect)
    {
        return;
    }
    m_treeAlarmInSetup.SelectItem(hSelect);
    DWORD dwIndex = m_treeAlarmInSetup.GetItemData(hSelect);
    BOOL bCheck = m_treeAlarmInSetup.GetCheck(hSelect);
    m_treeAlarmInSetup.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byAlarmInSetup[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM || uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeAlarmInSetup.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byAlarmInSetup[dwIndex] = !bCheck;
    }
    else
    {
        m_treeAlarmInSetup.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byAlarmInSetup[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}


void DlgEventCardLinkageCfg::OnNMClickTreeAlarmInClose(NMHDR *pNMHDR, LRESULT *pResult)
{
    // TODO:  在此添加控件通知处理程序代码
    UpdateData(TRUE);
    CPoint pt(0, 0);
    CRect rc(0, 0, 0, 0);
    GetCursorPos(&pt);
    m_treeAlarmInClose.ScreenToClient(&pt);
    m_treeAlarmInClose.GetWindowRect(&rc);
    m_treeAlarmInClose.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;

    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeAlarmInClose.HitTest(pt, &uFlag);

    if (NULL == hSelect)
    {
        return;
    }
    m_treeAlarmInClose.SelectItem(hSelect);
    DWORD dwIndex = m_treeAlarmInClose.GetItemData(hSelect);
    BOOL bCheck = m_treeAlarmInClose.GetCheck(hSelect);
    m_treeAlarmInClose.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byAlarmInClose[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM || uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)
    {
        m_treeAlarmInClose.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byAlarmInClose[dwIndex] = !bCheck;
    }
    else
    {
        m_treeAlarmInClose.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byAlarmInClose[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}


void DlgEventCardLinkageCfg::InitMainEventType()
{
    // WORD  wMainEventType;  //事件主类型，0-设备事件，1-报警输入事件，2-门事件，3-读卡器事
	char szLan[1024] = {0};
    m_comboMainEventType.ResetContent();
	g_StringLanType(szLan, "设备事件", "Device Event");
    m_comboMainEventType.InsertString(0,szLan);
	g_StringLanType(szLan, "报警输入事件", "AlarmIn Event");
    m_comboMainEventType.InsertString(1,szLan);
	g_StringLanType(szLan, "门事件", "Door Event");
    m_comboMainEventType.InsertString(2,szLan);
	g_StringLanType(szLan, "读卡器事件", "CardReader Event");
    m_comboMainEventType.InsertString(3,szLan);
    m_comboMainEventType.SetCurSel(0);
}

void DlgEventCardLinkageCfg::SubEventTypeDev()
{
    // WORD  wSubEventType;  
	char szLan[1024] = {0};

    m_comboSubEventType.ResetContent();
	g_StringLanType(szLan, "主机防拆报警", "Host Tamper Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_HOST_ANTI_DISMANTLE,szLan);
	g_StringLanType(szLan, "离线事件满90%报警", "Device Event");
    m_comboSubEventType.InsertString(EVENT_ACS_OFFLINE_ECENT_NEARLY_FULL,szLan);
	g_StringLanType(szLan, "网络断开", "Network Disconnect");
    m_comboSubEventType.InsertString(EVENT_ACS_NET_BROKEN,szLan);
	g_StringLanType(szLan, "网络恢复", "Network Recovery");
    m_comboSubEventType.InsertString(EVENT_ACS_NET_RESUME,szLan);
	g_StringLanType(szLan, "蓄电池电压低", "Low Battery Voltage");
    m_comboSubEventType.InsertString(EVENT_ACS_LOW_BATTERY,szLan);
	g_StringLanType(szLan, "蓄电池电压恢复正常", "Battery Voltage normal");
    m_comboSubEventType.InsertString(EVENT_ACS_BATTERY_RESUME,szLan);
	g_StringLanType(szLan, "交流电断电", "AC Power Off");
    m_comboSubEventType.InsertString(EVENT_ACS_AC_OFF,szLan);
	g_StringLanType(szLan, "交流电恢复", "AC Power On");
    m_comboSubEventType.InsertString(EVENT_ACS_AC_RESUME,szLan);
	g_StringLanType(szLan, "SD卡存储满报警", "SD Card Full Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_SD_CARD_FULL,szLan);
	g_StringLanType(szLan, "联动抓拍事件报警", "Linkage Capture Event Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_LINKAGE_CAPTURE_PIC,szLan);
    g_StringLanType(szLan, "人脸图像画质低", "Image Quality Low");
    m_comboSubEventType.InsertString(EVENT_ACS_IMAGE_QUALITY_LOW, szLan);
    g_StringLanType(szLan, "指纹图像画质低", "Finger Print Quality Low");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGER_PRINT_QUALITY_LOW, szLan);
    g_StringLanType(szLan, "电池电压低", "Battery Electric Low");
    m_comboSubEventType.InsertString(EVENT_ACS_BATTERY_ELECTRIC_LOW, szLan);
    g_StringLanType(szLan, "电池电压恢复正常", "Battery Electric Resume");
    m_comboSubEventType.InsertString(EVENT_ACS_BATTERY_ELECTRIC_RESUME, szLan);
    g_StringLanType(szLan, "消防输入短路报警", "Fire import short circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_IMPORT_SHORT_CIRCUIT, szLan);
    g_StringLanType(szLan, "消防输入断路报警", "Fire import broken circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_IMPORT_BROKEN_CIRCUIT, szLan);
    g_StringLanType(szLan, "消防输入恢复", "Fire import resume");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_IMPORT_RESUME, szLan);
    g_StringLanType(szLan, "主控RS485环路节点断开", "Master RS485 loop node broken");
    m_comboSubEventType.InsertString(EVENT_ACS_MASTER_RS485_LOOPNODE_BROKEN, szLan);
    g_StringLanType(szLan, "主控RS485环路节点恢复", "Master RS485 loop node resume");
    m_comboSubEventType.InsertString(EVENT_ACS_MASTER_RS485_LOOPNODE_RESUME, szLan);
    g_StringLanType(szLan, "就地控制器掉线", "Local control offline");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCAL_CONTROL_OFFLINE, szLan);
    g_StringLanType(szLan, "就地控制器掉线恢复", "Local control resume");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCAL_CONTROL_RESUME, szLan);
    g_StringLanType(szLan, "就地下行RS485环路断开", "Local downside RS485 loopnode broken");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCAL_DOWNSIDE_RS485_LOOPNODE_BROKEN, szLan);
    g_StringLanType(szLan, "就地下行RS485环路恢复", "Local downside RS485 loopnode resume");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCAL_DOWNSIDE_RS485_LOOPNODE_RESUME, szLan);
    g_StringLanType(szLan, "分控器在线", "Distract controller online");
    m_comboSubEventType.InsertString(EVENT_ACS_DISTRACT_CONTROLLER_ONLINE, szLan);
    g_StringLanType(szLan, "分控器离线", "Distract controller offline");
    m_comboSubEventType.InsertString(EVENT_ACS_DISTRACT_CONTROLLER_OFFLINE, szLan);
    g_StringLanType(szLan, "消防按钮触发", "Fire button trigger");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_BUTTON_TRIGGER, szLan);
    g_StringLanType(szLan, "消防按钮恢复", "Fire button resume");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_BUTTON_RESUME, szLan);
    g_StringLanType(szLan, "维护按钮触发", "Maintenance button trigger");
    m_comboSubEventType.InsertString(EVENT_ACS_MAINTENANCE_BUTTON_TRIGGER, szLan);
    g_StringLanType(szLan, "维护按钮恢复", "Maintenance button resume");
    m_comboSubEventType.InsertString(EVENT_ACS_MAINTENANCE_BUTTON_RESUME, szLan);
    g_StringLanType(szLan, "紧急按钮触发", "Emergency button trigger");
    m_comboSubEventType.InsertString(EVENT_ACS_EMERGENCY_BUTTON_TRIGGER, szLan);
    g_StringLanType(szLan, "紧急按钮恢复", "Emergency button resume");
    m_comboSubEventType.InsertString(EVENT_ACS_EMERGENCY_BUTTON_RESUME, szLan);
    g_StringLanType(szLan, "与反潜回服务器通信断开", "Submarinebreak comm break");
    m_comboSubEventType.InsertString(EVENT_ACS_SUBMARINEBACK_COMM_BREAK, szLan);
    g_StringLanType(szLan, "与反潜回服务器通信恢复", "Submarinebreak comm resume");
    m_comboSubEventType.InsertString(EVENT_ACS_SUBMARINEBACK_COMM_RESUME, szLan);
    g_StringLanType(szLan, "远程实时布防", "Remote actual guard");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_ACTUAL_GUARD, szLan);
    g_StringLanType(szLan, "远程实时撤防", "Remote actual unguard");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_ACTUAL_UNGUARD, szLan);
    g_StringLanType(szLan, "电机或传感器异常", "Motor sensor exception");
    m_comboSubEventType.InsertString(EVENT_ACS_MOTOR_SENSOR_EXCEPTION, szLan);
    g_StringLanType(szLan, "CAN总线异常", "Can bus exception");
    m_comboSubEventType.InsertString(EVENT_ACS_CAN_BUS_EXCEPTION, szLan);
    g_StringLanType(szLan, "CAN总线恢复", "Can bus resume");
    m_comboSubEventType.InsertString(EVENT_ACS_CAN_BUS_RESUME, szLan);
    g_StringLanType(szLan, "闸机腔体温度超限", "Gate temperature overrun");
    m_comboSubEventType.InsertString(EVENT_ACS_GATE_TEMPERATURE_OVERRUN, szLan);
    g_StringLanType(szLan, "红外对射异常", "IR emitter exception");
    m_comboSubEventType.InsertString(EVENT_ACS_IR_EMITTER_EXCEPTION, szLan);
    g_StringLanType(szLan, "红外对射恢复", "IR emitter resume");
    m_comboSubEventType.InsertString(EVENT_ACS_IR_EMITTER_RESUME, szLan);
    g_StringLanType(szLan, "灯板通信异常", "Lamp board communicate exception");
    m_comboSubEventType.InsertString(EVENT_ACS_LAMP_BOARD_COMM_EXCEPTION, szLan);
    g_StringLanType(szLan, "灯板通信恢复", "Lamp board communicate resume");
    m_comboSubEventType.InsertString(EVENT_ACS_LAMP_BOARD_COMM_RESUME, szLan);
    g_StringLanType(szLan, "红外转接板通信异常", "IR adaptor board communicate exception");
    m_comboSubEventType.InsertString(EVENT_ACS_IR_ADAPTOR_BOARD_COMM_EXCEPTION, szLan);
    g_StringLanType(szLan, "红外转接板通信恢复", "MAC detect");
    m_comboSubEventType.InsertString(EVENT_ACS_IR_ADAPTOR_BOARD_COMM_RESUME, szLan);
    g_StringLanType(szLan, "通道控制器防拆报警", "Channel controller desmantle alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_CHANNEL_CONTROLLER_DESMANTLE_ALARM, szLan);
    g_StringLanType(szLan, "通道控制器防拆报警恢复", "Channel controller desmantle resume");
    m_comboSubEventType.InsertString(EVENT_ACS_CHANNEL_CONTROLLER_DESMANTLE_RESUME, szLan);
    g_StringLanType(szLan, "通道控制器消防输入报警", "Channel controller fire import alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_CHANNEL_CONTROLLER_FIRE_IMPORT_ALARM, szLan);
    g_StringLanType(szLan, "通道控制器消防输入报警恢复", "Channel controller fire import resume");
    m_comboSubEventType.InsertString(EVENT_ACS_CHANNEL_CONTROLLER_FIRE_IMPORT_RESUME, szLan);
    g_StringLanType(szLan, "逗留事件", "Stay event");
    m_comboSubEventType.InsertString(EVENT_ACS_STAY_EVENT, szLan);
    g_StringLanType(szLan, "离线合法事件满90%报警", "Offline legal event nearly full");
    m_comboSubEventType.InsertString(EVENT_ACS_LEGAL_EVENT_NEARLY_FULL, szLan);
    g_StringLanType(szLan, "消防输入报警", "fire import alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRE_IMPORT_ALARM, szLan);
    g_StringLanType(szLan, "未带口罩报警", "no mask alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_NOMASK_ALARM, szLan);

    m_comboSubEventType.SetCurSel(EVENT_ACS_HOST_ANTI_DISMANTLE);
}

void DlgEventCardLinkageCfg::SubEventTypeAlarm()
{
    // WORD  wSubEventType; 
	char szLan[1024] = {0};

    m_comboSubEventType.ResetContent();
	g_StringLanType(szLan, "防区短路报警", "Zone Short-Circuit Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_ALARMIN_SHORT_CIRCUIT,szLan);
	g_StringLanType(szLan, "防区断路报警", "Zone Circuit Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_ALARMIN_BROKEN_CIRCUIT,szLan);
	g_StringLanType(szLan, "防区异常报警", "Abnormal Zone Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_ALARMIN_EXCEPTION,szLan);
	g_StringLanType(szLan, "防区报警恢复", "Zone Alarm Recover");
    m_comboSubEventType.InsertString(EVENT_ACS_ALARMIN_RESUME,szLan);
	g_StringLanType(szLan, "事件输入报警", "Event Input Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_CASE_SENSOR_ALARM,szLan);
	g_StringLanType(szLan, "事件输入恢复", "Event Recover Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_CASE_SENSOR_RESUME,szLan);
    m_comboSubEventType.SetCurSel(EVENT_ACS_ALARMIN_SHORT_CIRCUIT);
}

void DlgEventCardLinkageCfg::SubEventTypeDoor()
{
    // WORD  wSubEventType;  
    m_comboSubEventType.ResetContent();
    char szLan[1024] = { 0 };

    g_StringLanType(szLan, "首卡开门开始", "Leader Card Open Begin");
    m_comboSubEventType.InsertString(EVENT_ACS_LEADER_CARD_OPEN_BEGIN, szLan);
    g_StringLanType(szLan, "首卡开门结束", "Leader Card Open End");
    m_comboSubEventType.InsertString(EVENT_ACS_LEADER_CARD_OPEN_END, szLan);
    g_StringLanType(szLan, "常开状态开始", "Always Open Begin");
    m_comboSubEventType.InsertString(EVENT_ACS_ALWAYS_OPEN_BEGIN, szLan);
    g_StringLanType(szLan, "常开状态结束", "Always Open End");
    m_comboSubEventType.InsertString(EVENT_ACS_ALWAYS_OPEN_END, szLan);
    g_StringLanType(szLan, "常关状态开始", "Always Close Begin");
    m_comboSubEventType.InsertString(EVENT_ACS_ALWAYS_CLOSE_BEGIN, szLan);
    g_StringLanType(szLan, "常关状态结束", "Always Close End");
    m_comboSubEventType.InsertString(EVENT_ACS_ALWAYS_CLOSE_END, szLan);
    g_StringLanType(szLan, "门锁打开", "Lock Open");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCK_OPEN, szLan);
    g_StringLanType(szLan, "门锁关闭", "Lock Close");
    m_comboSubEventType.InsertString(EVENT_ACS_LOCK_CLOSE, szLan);
    g_StringLanType(szLan, "开门按钮按下", "Door Button Press");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_BUTTON_PRESS, szLan);
    g_StringLanType(szLan, "开门按钮放开", "Door Button Release");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_BUTTON_RELEASE, szLan);
    g_StringLanType(szLan, "正常开门（门磁）", "Door Open Normal");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_OPEN_NORMAL, szLan);
    g_StringLanType(szLan, "正常关门（门磁）", "Door Close Normal");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_CLOSE_NORMAL, szLan);
    g_StringLanType(szLan, "门异常打开（门磁）", "Door Open Abnormal");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_OPEN_ABNORMAL, szLan);
    g_StringLanType(szLan, "门打开超时（门磁）", "Door Open Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_OPEN_TIMEOUT, szLan);
    g_StringLanType(szLan, "远程开门", "Remote Open Door");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_OPEN_DOOR, szLan);
    g_StringLanType(szLan, "远程关门", "Remote Close Door");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_CLOSE_DOOR, szLan);
    g_StringLanType(szLan, "远程常开", "Remote Always Open");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_ALWAYS_OPEN, szLan);
    g_StringLanType(szLan, "远程常关", "Remote Always Close");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_ALWAYS_CLOSE, szLan);
    g_StringLanType(szLan, "卡不属于多重认证群组", "Not Belong Multi Group");
    m_comboSubEventType.InsertString(EVENT_ACS_NOT_BELONG_MULTI_GROUP, szLan);
    g_StringLanType(szLan, "卡不在多重认证时间段内", "Invalid Multi Verify Period");
    m_comboSubEventType.InsertString(EVENT_ACS_INVALID_MULTI_VERIFY_PERIOD, szLan);
    g_StringLanType(szLan, "多重认证模式超级密码认证失败", "Multi Verify Super Right Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_SUPER_RIGHT_FAIL, szLan);
    g_StringLanType(szLan, "多重认证模式远程认证失败", "Multi Verify Remote Right Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_REMOTE_RIGHT_FAIL, szLan);
    g_StringLanType(szLan, "多重认证成功", "Multi Verify Success");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_SUCCESS, szLan);
    g_StringLanType(szLan, "多重多重认证需要远程开门", "Multi Verify Need Remote Open");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_NEED_REMOTE_OPEN, szLan);
    g_StringLanType(szLan, "多重认证超级密码认证成功事件", "Multi Verify Super Password Verify Success");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_SUPERPASSWD_VERIFY_SUCCESS, szLan);
    g_StringLanType(szLan, "多重认证重复认证失败", "Multi Verify Repeat Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_REPEAT_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "多重认证超时失败", "Multi Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_MULTI_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "远程抓拍", "Remote Capture Picture");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_CAPTURE_PIC, szLan);
    g_StringLanType(szLan, "门铃响", "Door Bell Ringing");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORBELL_RINGING, szLan);
    g_StringLanType(szLan, "门控安全模块防拆报警", "Security Module Desmantle Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_SECURITY_MODULE_DESMANTLE_ALARM, szLan);
    g_StringLanType(szLan, "呼叫中心事件", "Call Center");
    m_comboSubEventType.InsertString(EVENT_ACS_CALL_CENTER, szLan);
    g_StringLanType(szLan, "首卡授权开始", "First Card Authorize Begin");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRSTCARD_AUTHORIZE_BEGIN, szLan);
    g_StringLanType(szLan, "首卡授权结束", "First Card Authorize End");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRSTCARD_AUTHORIZE_END, szLan);
    g_StringLanType(szLan, "门锁输入短路报警", "Door Lock Input Short Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORLOCK_INPUT_SHORT_CIRCUIT, szLan);
    g_StringLanType(szLan, "门锁输入断路报警", "Door Lock Input Broken Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORLOCK_INPUT_BROKEN_CIRCUIT, szLan);
    g_StringLanType(szLan, "门锁输入异常报警", "Door Lock Input Exception");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORLOCK_INPUT_EXCEPTION, szLan);
    g_StringLanType(szLan, "门磁输入短路报警", "Door Contact Input Short Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORCONTACT_INPUT_SHORT_CIRCUIT, szLan);
    g_StringLanType(szLan, "门磁输入断路报警", "Door Contact Input Broken Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORCONTACT_INPUT_BROKEN_CIRCUIT, szLan);
    g_StringLanType(szLan, "门磁输入异常报警", "Door Contact Input Exception");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORCONTACT_INPUT_EXCEPTION, szLan);
    g_StringLanType(szLan, "开门按钮输入短路报警", "Open Button Input Short Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_OPENBUTTON_INPUT_SHORT_CIRCUIT, szLan);
    g_StringLanType(szLan, "开门按钮输入断路报警", "Open Button Input Broken Circuit");
    m_comboSubEventType.InsertString(EVENT_ACS_OPENBUTTON_INPUT_BROKEN_CIRCUIT, szLan);
    g_StringLanType(szLan, "开门按钮输入异常报警", "Open Button Input Exception");
    m_comboSubEventType.InsertString(EVENT_ACS_OPENBUTTON_INPUT_EXCEPTION, szLan);
    g_StringLanType(szLan, "门锁异常打开", "Door Lock Open Exception");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORLOCK_OPEN_EXCEPTION, szLan);
    g_StringLanType(szLan, "门锁打开超时", "Door Lock Open Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_DOORLOCK_OPEN_TIMEOUT, szLan);
    g_StringLanType(szLan, "首卡未授权开门失败", "First Card Open Without Authorize");
    m_comboSubEventType.InsertString(EVENT_ACS_FIRSTCARD_OPEN_WITHOUT_AUTHORIZE, szLan);
    g_StringLanType(szLan, "呼梯继电器断开", "Call Ladder Relay Break");
    m_comboSubEventType.InsertString(EVENT_ACS_CALL_LADDER_RELAY_BREAK, szLan);
    g_StringLanType(szLan, "呼梯继电器闭合", "Call Ladder Relay Close");
    m_comboSubEventType.InsertString(EVENT_ACS_CALL_LADDER_RELAY_CLOSE, szLan);
    g_StringLanType(szLan, "自动按键继电器断开", "Auto Key Relay Break");
    m_comboSubEventType.InsertString(EVENT_ACS_AUTO_KEY_RELAY_BREAK, szLan);
    g_StringLanType(szLan, "自动按键继电器闭合", "Auto Key Relay Close");
    m_comboSubEventType.InsertString(EVENT_ACS_AUTO_KEY_RELAY_CLOSE, szLan);
    g_StringLanType(szLan, "按键梯控继电器断开", "Key Control Relay Break");
    m_comboSubEventType.InsertString(EVENT_ACS_KEY_CONTROL_RELAY_BREAK, szLan);
    g_StringLanType(szLan, "按键梯控继电器闭合", "Key Control Relay Close");
    m_comboSubEventType.InsertString(EVENT_ACS_KEY_CONTROL_RELAY_CLOSE, szLan);
    g_StringLanType(szLan, "访客呼梯", "Remote Visitor Call Ladder");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_VISITOR_CALL_LADDER, szLan);
    g_StringLanType(szLan, "住户呼梯", "Remote House Hold Call Ladder");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_HOUSEHOLD_CALL_LADDER, szLan);
    g_StringLanType(szLan, "合法短信", "Legal Message");
    m_comboSubEventType.InsertString(EVENT_ACS_LEGAL_MESSAGE, szLan);
    g_StringLanType(szLan, "非法短信", "Illegal Message");
    m_comboSubEventType.InsertString(EVENT_ACS_ILLEGAL_MESSAGE, szLan);
    g_StringLanType(szLan, "尾随通行", "Trailing");
    m_comboSubEventType.InsertString(EVENT_ACS_TRAILING, szLan);
    g_StringLanType(szLan, "反向闯入", "Reverse Access");
    m_comboSubEventType.InsertString(EVENT_ACS_REVERSE_ACCESS, szLan);
    g_StringLanType(szLan, "外力冲撞", "Force Access");
    m_comboSubEventType.InsertString(EVENT_ACS_FORCE_ACCESS, szLan);
    g_StringLanType(szLan, "翻越", "Climbing Over Gate");
    m_comboSubEventType.InsertString(EVENT_ACS_CLIMBING_OVER_GATE, szLan);
    g_StringLanType(szLan, "通行超时", "Passing Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_PASSING_TIMEOUT, szLan);
    g_StringLanType(szLan, "误闯报警", "Intrusion Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_INTRUSION_ALARM, szLan);
    g_StringLanType(szLan, "闸机自由通行时未认证通过", "Free Gate Pass Not Auth");
    m_comboSubEventType.InsertString(EVENT_ACS_FREE_GATE_PASS_NOT_AUTH, szLan);
    g_StringLanType(szLan, "摆臂被阻挡", "Drop Arm Block");
    m_comboSubEventType.InsertString(EVENT_ACS_DROP_ARM_BLOCK, szLan);
    g_StringLanType(szLan, "摆臂阻挡消除", "Drop Arm Block Resume");
    m_comboSubEventType.InsertString(EVENT_ACS_DROP_ARM_BLOCK_RESUME, szLan);
    g_StringLanType(szLan, "遥控器关门", "Remote Control Close Door");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_CONTROL_CLOSE_DOOR, szLan);
    g_StringLanType(szLan, "遥控器开门", "Remote Control Open Door");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_CONTROL_OPEN_DOOR, szLan);
    g_StringLanType(szLan, "遥控器常开门", "Remote Control Always Open Door");
    m_comboSubEventType.InsertString(EVENT_ACS_REMOTE_CONTROL_ALWAYS_OPEN_DOOR, szLan);
    m_comboSubEventType.SetCurSel(EVENT_ACS_LEADER_CARD_OPEN_BEGIN);
}

void DlgEventCardLinkageCfg::SubEventTypeCardReader()
{
    // WORD  wSubEventType;  
    m_comboSubEventType.ResetContent();
    char szLan[1024] = { 0 };

    g_StringLanType(szLan, "胁迫报警", "Stress Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_STRESS_ALARM, szLan);
    g_StringLanType(szLan, "读卡器防拆报警", "Card Reader Desmantle Alarm");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_READER_DESMANTLE_ALARM, szLan);
    g_StringLanType(szLan, "合法卡认证通过", "Legal Card Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_LEGAL_CARD_PASS, szLan);
    g_StringLanType(szLan, "刷卡加密码认证通过", "Card And Password Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_AND_PSW_PASS, szLan);
    g_StringLanType(szLan, "刷卡加密码认证失败", "Card And Password Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_AND_PSW_FAIL, szLan);
    g_StringLanType(szLan, "刷卡加密码认证超时", "Card And Password Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_AND_PSW_TIMEOUT, szLan);
    g_StringLanType(szLan, "读卡器认证失败超次", "Max Authenticate Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_MAX_AUTHENTICATE_FAIL, szLan);
    g_StringLanType(szLan, "卡未分配权限", "Card No Right");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_NO_RIGHT, szLan);
    g_StringLanType(szLan, "卡当前时段无效", "Card Invalid Period");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_INVALID_PERIOD, szLan);
    g_StringLanType(szLan, "卡号过期", "Card Out Of Date");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_OUT_OF_DATE, szLan);
    g_StringLanType(szLan, "无此卡号", "Invalid Card");
    m_comboSubEventType.InsertString(EVENT_ACS_INVALID_CARD, szLan);
    g_StringLanType(szLan, "反潜回认证失败", "Anti Sneak Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_ANTI_SNEAK_FAIL, szLan);
    g_StringLanType(szLan, "互锁门未关闭", "Interlock Door Not Close");
    m_comboSubEventType.InsertString(EVENT_ACS_INTERLOCK_DOOR_NOT_CLOSE, szLan);
    g_StringLanType(szLan, "指纹比对通过", "Fingerprint Compare Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_COMPARE_PASS, szLan);
    g_StringLanType(szLan, "指纹比对失败", "Fingerprint Compare Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_COMPARE_FAIL, szLan);
    g_StringLanType(szLan, "刷卡加指纹认证通过", "Card Fingerprint Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "刷卡加指纹认证失败", "Card Fingerprint Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "刷卡加指纹认证超时", "Card Fingerprint Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "刷卡加指纹加密码认证通过", "Card Fingerprint Password Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_PASSWD_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "刷卡加指纹加密码认证失败", "Card Fingerprint Password Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_PASSWD_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "刷卡加指纹加密码认证超时", "Card Fingerprint Password Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_FINGERPRINT_PASSWD_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "指纹加密码认证通过", "Fingerprint Password Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_PASSWD_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "指纹加密码认证失败", "Fingerprint Password Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_PASSWD_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "指纹加密码认证超时", "Fingerprint Password Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_PASSWD_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "指纹不存在", "Fingerprint Not Existence");
    m_comboSubEventType.InsertString(EVENT_ACS_FINGERPRINT_INEXISTENCE, szLan);
    g_StringLanType(szLan, "人脸认证通过", "Face Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸认证失败", "Face Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加指纹认证通过", "Face And Fingerprint Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_FP_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸加指纹认证失败", "Face And Fingerprint Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_FP_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加指纹认证超时", "Face And Fingerprint Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_FP_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "人脸加密码认证通过", "Face And Password Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸加密码认证失败", "Face And Password Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加密码认证超时", "Face And Password Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "人脸加刷卡认证通过", "Face And Card Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸加刷卡认证失败", "Face And Card Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加刷卡认证超时", "Face And Card Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "人脸加密码加指纹认证通过", "Face And Password And Fingerprint Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_AND_FP_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸加密码加指纹认证失败", "Face And Password And Fingerprint Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_AND_FP_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加密码加指纹认证超时", "Face And Password And Fingerprint Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_PW_AND_FP_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "人脸加刷卡加指纹认证通过", "Face And Card And Fingerprint Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_AND_FP_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "人脸加刷卡加指纹认证失败", "Face And Card And Fingerprint Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_AND_FP_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "人脸加刷卡加指纹认证超时", "Face And Card And Fingerprint Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_AND_CARD_AND_FP_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "工号加指纹认证通过", "Employee No And Fingerprint Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "工号加指纹认证失败", "Employee No And Fingerprint Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "工号加指纹认证超时", "Employee No And Fingerprint Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "工号加指纹加密码认证通过", "Employee No And Fingerprint And Password Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_AND_PW_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "工号加指纹加密码认证失败", "Employee No And Fingerprint And Password Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_AND_PW_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "工号加指纹加密码认证超时", "Employee No And Fingerprint And Password Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FP_AND_PW_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "工号加人脸认证通过", "Employee No And Face Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FACE_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "工号加人脸认证失败", "Employee No And Face Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FACE_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "工号加人脸认证超时", "Employee No And Face Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_FACE_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "人脸识别失败", "Face Recognize Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_FACE_RECOGNIZE_FAIL, szLan);
    g_StringLanType(szLan, "工号加密码认证通过", "Employee No And Password Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_PW_PASS, szLan);
    g_StringLanType(szLan, "工号加密码认证失败", "Employee No And Password Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_PW_FAIL, szLan);
    g_StringLanType(szLan, "工号加密码认证超时", "Employee No And Password Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEENO_AND_PW_TIMEOUT, szLan);
    g_StringLanType(szLan, "真人检测失败", "Human Detect Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_HUMAN_DETECT_FAIL, szLan);
    g_StringLanType(szLan, "人证比对通过", "People And Id Card Compare Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_PEOPLE_AND_ID_CARD_COMPARE_PASS, szLan);
    g_StringLanType(szLan, "人证比对失败", "People And Id Card Compare Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_PEOPLE_AND_ID_CARD_COMPARE_FAIL, szLan);
    g_StringLanType(szLan, "门状态常闭或休眠状态认证失败", "Door Open Or Dormant Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_DOOR_OPEN_OR_DORMANT_FAIL, szLan);
    g_StringLanType(szLan, "认证计划休眠模式认证失败", "Auth Plan Dormant Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_AUTH_PLAN_DORMANT_FAIL, szLan);
    g_StringLanType(szLan, "卡加密校验失败", "Card Encrypt Verify Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_ENCRYPT_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "反潜回服务器应答失败", "Submarineback Relay Fail");
    m_comboSubEventType.InsertString(EVENT_ACS_SUBMARINEBACK_REPLY_FAIL, szLan);
    g_StringLanType(szLan, "密码不匹配", "Password Mismatch");
    m_comboSubEventType.InsertString(EVENT_ACS_PASSWORD_MISMATCH, szLan);
    g_StringLanType(szLan, "工号不存在", "Employee No Not Exist");
    m_comboSubEventType.InsertString(EVENT_ACS_EMPLOYEE_NO_NOT_EXIST, szLan);
    g_StringLanType(szLan, "组合认证通过", "Combined Verify Pass");
    m_comboSubEventType.InsertString(EVENT_ACS_COMBINED_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "组合认证超时", "Combined Verify Timeout");
    m_comboSubEventType.InsertString(EVENT_ACS_COMBINED_VERIFY_TIMEOUT, szLan);
    g_StringLanType(szLan, "认证方式不匹配", "Verify Mode Mismatch");
    m_comboSubEventType.InsertString(EVENT_ACS_VERIFY_MODE_MISMATCH, szLan);
    g_StringLanType(szLan, "密码认证超次", "PSW error over times");
    m_comboSubEventType.InsertString(EVENT_ACS_PSW_ERROR_OVER_TIMES, szLan);
    g_StringLanType(szLan, "密码认证通过", "PSW verify pass");
    m_comboSubEventType.InsertString(EVENT_ACS_PSW_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "密码认证失败", "PSW verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_PSW_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "二维码认证通过", "ORcode verify pass");
    m_comboSubEventType.InsertString(EVENT_ACS_ORCODE_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "二维码认证失败", "ORcode verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_ORCODE_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "户主授权认证通过", "HouseHolder authorize pass");
    m_comboSubEventType.InsertString(EVENT_ACS_HOUSEHOLDER_AUTHORIZE_PASS, szLan);
    g_StringLanType(szLan, "蓝牙认证通过", "Bluetooth verify pass");
    m_comboSubEventType.InsertString(EVENT_ACS_BLUETOOTH_VERIFY_PASS, szLan);
    g_StringLanType(szLan, "蓝牙认证失败", "Bluetooth verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_BLUETOOTH_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "非正规Mifare卡认证失败", "Inforaml mifare card verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_INFORMAL_MIFARE_CARD_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "CPU卡加密校验失败", "CPU card encrypt verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CPU_CARD_ENCRYPT_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "NFC功能关闭验证失败", "NFC disable verify fail");
    m_comboSubEventType.InsertString(EVENT_ACS_NFC_DISABLE_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "EM卡识别未启用", "EM card recognize not enabled");
    m_comboSubEventType.InsertString(EVENT_ACS_EM_CARD_RECOGNIZE_NOT_ENABLED, szLan);
    g_StringLanType(szLan, "M1卡识别未启用", "M1 card recognize not enabled");
    m_comboSubEventType.InsertString(EVENT_ACS_M1_CARD_RECOGNIZE_NOT_ENABLED, szLan);
    g_StringLanType(szLan, "CPU卡识别未启用", "CPU card recognize not enabled");
    m_comboSubEventType.InsertString(EVENT_ACS_CPU_CARD_RECOGNIZE_NOT_ENABLED, szLan);
    g_StringLanType(szLan, "身份证识别未启用", "ID card recognize not enabled");
    m_comboSubEventType.InsertString(EVENT_ACS_ID_CARD_RECOGNIZE_NOT_ENABLED, szLan);
    g_StringLanType(szLan, "卡灌装密钥失败", "card set secret key fail");
    m_comboSubEventType.InsertString(EVENT_ACS_CARD_SET_SECRET_KEY_FAIL, szLan);
    g_StringLanType(szLan, "Desfire卡加密校验失败", "desfire card set secret key fail");
    m_comboSubEventType.InsertString(EVENT_ACS_DESFIRE_CARD_ENCRYPT_VERIFY_FAIL, szLan);
    g_StringLanType(szLan, "Desfire卡识别未启用", "desfire card recognize not enabled");
    m_comboSubEventType.InsertString(EVENT_ACS_DESFIRE_CARD_RECOGNIZE_NOT_ENABLED, szLan);
    m_comboSubEventType.SetCurSel(EVENT_ACS_STRESS_ALARM);
}

UINT8 DlgEventCardLinkageCfg::charToData(const char ch)
{
    switch (ch)
    {
    case '0':
        return 0;
    case '1':
        return 1;
    case '2':
        return 2;
    case '3':
        return 3;
    case '4':
        return 4;
    case '5':
        return 5;
    case '6':
        return 6;
    case '7':
        return 7;
    case '8':
        return 8;
    case '9':
        return 9;
    case 'a':
    case 'A':
        return 10;
    case 'b':
    case 'B':
        return 11;
    case 'c':
    case 'C':
        return 12;
    case 'd':
    case 'D':
        return 13;
    case 'e':
    case 'E':
        return 14;
    case 'f':
    case 'F':
        return 15;
    }
    return 0;
}

bool DlgEventCardLinkageCfg::StrToMac(const char * szMac, UINT8 * pMac)
{
    const char * pTemp = szMac;
    for (int i = 0; i < 6; ++i)
    {
        pMac[i] = charToData(*pTemp++) * 16;
        pMac[i] += charToData(*pTemp++);
        pTemp++;
    }
    return TRUE;
}

void DlgEventCardLinkageCfg::OnClickTreeReaderStopBuzzer(NMHDR *pNMHDR, LRESULT *pResult)
{
    // TODO: Add your control notification handler code here
    UpdateData(TRUE);

    CPoint pt(0, 0);
    CRect rc(0, 0, 0, 0);
    GetCursorPos(&pt);
    m_treeCardReaderStopBuzzer.ScreenToClient(&pt);
    GetDlgItem(IDC_TREE_READER_STOP_BUZZER)->GetWindowRect(&rc);
    m_treeCardReaderStopBuzzer.ScreenToClient(&rc);
    pt.x = pt.x - rc.left;
    pt.y = pt.y - rc.top;

    UINT uFlag = 0;
    HTREEITEM hSelect = m_treeCardReaderStopBuzzer.HitTest(pt, &uFlag);

    if (NULL == hSelect)
    {
        return;
    }
    m_treeCardReaderStopBuzzer.SelectItem(hSelect);
    DWORD dwIndex = m_treeCardReaderStopBuzzer.GetItemData(hSelect);
    BOOL bCheck = m_treeCardReaderStopBuzzer.GetCheck(hSelect);
    m_treeCardReaderStopBuzzer.SetCheck(hSelect, !bCheck);
    m_struEventCardLinkageCfgV51.byReaderStopBuzzer[dwIndex] = !bCheck;
    //switch checkbox status on click
    if (uFlag & LVHT_ONITEM || uFlag & LVHT_TOLEFT || uFlag & LVHT_ONITEMLABEL)//LVHT_TOLEFT)
    {
        m_treeCardReaderStopBuzzer.SetCheck(hSelect, !bCheck);
        m_struEventCardLinkageCfgV51.byReaderStopBuzzer[dwIndex] = !bCheck;
    }
    else
    {
        m_treeCardReaderStopBuzzer.SetCheck(hSelect, bCheck);
        m_struEventCardLinkageCfgV51.byReaderStopBuzzer[dwIndex] = bCheck;
    }
    UpdateData(FALSE);
    *pResult = 0;
}
