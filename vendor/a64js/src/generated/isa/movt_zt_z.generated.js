export const ENCODINGS = [
    {
        "instructionId": "movt_zt_z",
        "encodingId": "movt_zt_z_",
        "mnemonic": "MOVT",
        "className": "SME2",
        "fileName": "movt_zt_z.xml",
        "mask": 4294954976,
        "value": 3226403808,
        "bitCount": 25,
        "fields": [
            {
                "name": "off2",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 7
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME_LUTv2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_LUTv2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-movt-zt"
    }
];
